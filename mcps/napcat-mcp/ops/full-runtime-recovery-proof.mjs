import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { win32 } from 'node:path';

const freshnessMs = 10_000;
const hashPattern = /^[a-f0-9]{64}$/u;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/u;
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positivePid = value => Number.isSafeInteger(value) && value > 0;
const portNumber = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;

function timestamp(value, code) {
  if (typeof value !== 'string' || !isoPattern.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/u).map(Number);
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > monthDays || hour > 23 || minute > 59 || second > 59) fail(code);
  return Date.parse(value);
}

function executable(value) {
  if (typeof value !== 'string' || !value.trim() || !win32.isAbsolute(value)
    || /[\x00-\x1f]/u.test(value)) fail('RECOVERY_PROCESS_EXECUTABLE_UNKNOWN');
  return win32.normalize(value).toLowerCase();
}

function fresh(value, now, code) {
  const observed = timestamp(value, code);
  if (observed > now || now - observed > freshnessMs) fail(code);
}

function processIndex(processes) {
  if (!Array.isArray(processes)) fail('RECOVERY_PROCESS_SNAPSHOT_MISSING');
  const indexed = new Map();
  for (const process of processes) {
    if (!object(process) || !positivePid(process.pid) || !Number.isSafeInteger(process.parentPid)
      || process.parentPid < 0 || process.parentPid === process.pid || indexed.has(process.pid)) {
      fail('RECOVERY_PROCESS_RELATION_UNKNOWN');
    }
    indexed.set(process.pid, process);
  }
  return indexed;
}

function assertProcessIdentity(process) {
  timestamp(process.creationDate, 'RECOVERY_PROCESS_CREATION_UNKNOWN');
  executable(process.executablePath);
  if (typeof process.commandLine !== 'string' || !process.commandLine.trim()) fail('RECOVERY_PROCESS_COMMAND_UNKNOWN');
}

function checkedListeners(listeners) {
  if (!Array.isArray(listeners)) fail('RECOVERY_LISTENER_SNAPSHOT_MISSING');
  return listeners.map(listener => {
    if (object(listener) && ['port', 'pid', 'address'].some(name => Object.hasOwn(listener, name))) {
      if (!portNumber(listener.port) || !positivePid(listener.pid) || typeof listener.address !== 'string'
        || isIP(listener.address) === 0 || ['localPort', 'owningProcess', 'state'].some(name => Object.hasOwn(listener, name))) {
        fail('RECOVERY_LISTENER_UNKNOWN');
      }
      return { localPort: listener.port, owningProcess: listener.pid };
    }
    if (!object(listener) || !portNumber(listener.localPort) || !positivePid(listener.owningProcess)
      || listener.state !== 'Listen') fail('RECOVERY_LISTENER_UNKNOWN');
    return { localPort: listener.localPort, owningProcess: listener.owningProcess };
  });
}

function capture(process) {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    creationDate: process.creationDate,
    executablePath: process.executablePath,
    commandLineSha256: digest(process.commandLine),
  };
}

function assertBindings(bindings, indexed, parentPid, appServerPid) {
  if (!Array.isArray(bindings) || bindings.length < 2) fail('RECOVERY_PROCESS_BINDINGS_MISSING');
  const bound = new Set();
  for (const binding of bindings) {
    if (!object(binding) || !positivePid(binding.pid) || bound.has(binding.pid)
      || typeof binding.commandLineSha256 !== 'string' || !hashPattern.test(binding.commandLineSha256)) {
      fail('RECOVERY_PROCESS_BINDING_INVALID');
    }
    timestamp(binding.creationDate, 'RECOVERY_PROCESS_BINDING_INVALID');
    const observed = indexed.get(binding.pid);
    if (!observed) fail('RECOVERY_PROCESS_BINDING_CHANGED');
    assertProcessIdentity(observed);
    if (observed.creationDate !== binding.creationDate
      || executable(observed.executablePath) !== executable(binding.executablePath)
      || digest(observed.commandLine) !== binding.commandLineSha256) fail('RECOVERY_PROCESS_BINDING_CHANGED');
    bound.add(binding.pid);
  }
  if (!bound.has(parentPid) || !bound.has(appServerPid)) fail('RECOVERY_PARENT_APP_BINDINGS_REQUIRED');
  return bound;
}

function descendants(roots, indexed) {
  const captured = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of indexed.values()) {
      if (captured.has(process.parentPid) && !captured.has(process.pid)) {
        captured.add(process.pid);
        changed = true;
      }
    }
  }
  for (const processId of captured) {
    const visited = new Set();
    let current = indexed.get(processId);
    while (current && captured.has(current.pid)) {
      if (visited.has(current.pid)) fail('RECOVERY_PROCESS_RELATION_UNKNOWN');
      visited.add(current.pid);
      const parent = indexed.get(current.parentPid);
      if (parent && captured.has(parent.pid)
        && timestamp(parent.creationDate, 'RECOVERY_PROCESS_CREATION_UNKNOWN')
          > timestamp(current.creationDate, 'RECOVERY_PROCESS_CREATION_UNKNOWN')) {
        fail('RECOVERY_PROCESS_PARENT_REUSED');
      }
      current = parent;
    }
  }
  return captured;
}

function assertNoDesktop(indexed, appServerPid) {
  for (const process of indexed.values()) {
    const name = typeof process.name === 'string' && process.name.trim() ? process.name.toLowerCase() : null;
    const imageName = typeof process.executablePath === 'string' && process.executablePath.trim()
      ? win32.basename(executable(process.executablePath)) : null;
    if (!name && !imageName) fail('RECOVERY_DESKTOP_IDENTITY_UNKNOWN');
    if (name === 'chatgpt.exe' || imageName === 'chatgpt.exe') fail('RECOVERY_DESKTOP_RUNNING');
    if (name !== 'codex.exe' && imageName !== 'codex.exe') continue;
    if (typeof process.commandLine !== 'string' || !process.commandLine.trim()) fail('RECOVERY_DESKTOP_IDENTITY_UNKNOWN');
    if (!/app-server/iu.test(process.commandLine)) fail('RECOVERY_DESKTOP_RUNNING');
    if (process.pid !== appServerPid) fail('RECOVERY_UNBOUND_APP_SERVER');
  }
}

function expectedHashes(profile) {
  const hashes = profile?.initial?.expectedHashes;
  const names = ['runner', 'core', 'helper', 'control'];
  if (!object(hashes) || Object.keys(hashes).length !== names.length
    || names.some(name => typeof hashes[name] !== 'string' || !hashPattern.test(hashes[name]))) {
    fail('RECOVERY_EXPECTED_SOURCE_HASHES_MISSING');
  }
  return hashes;
}

export function assertRecoveryQuiescent({ input, profile, runtime, managed, processes, listeners, now, workerSources } = {}) {
  const instant = now instanceof Date ? now.getTime() : typeof now === 'string'
    ? timestamp(now, 'RECOVERY_NOW_INVALID') : now;
  if (!Number.isSafeInteger(instant) || instant < 0 || !Number.isFinite(new Date(instant).getTime())) fail('RECOVERY_NOW_INVALID');
  if (!object(input) || !positivePid(input.parentPid) || !positivePid(input.appServerPid)
    || input.parentPid === input.appServerPid || typeof input.instanceId !== 'string' || !input.instanceId.trim()) {
    fail('RECOVERY_INPUT_IDENTITY_MISSING');
  }
  let control;
  try { control = new URL(input.controlUrl); } catch { fail('RECOVERY_CONTROL_URL_INVALID'); }
  if (control.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(control.hostname)
    || control.pathname !== '/' || control.search || control.hash || control.username || control.password
    || !portNumber(Number(control.port))) fail('RECOVERY_CONTROL_URL_INVALID');
  if (!object(runtime) || runtime.pid !== input.parentPid || runtime.appServerPid !== input.appServerPid
    || runtime.instanceToken !== input.instanceId || runtime.controlUrl !== input.controlUrl || runtime.state !== 'running') {
    fail('RECOVERY_RUNTIME_INSTANCE_CHANGED');
  }
  fresh(runtime.livenessAt, instant, 'RECOVERY_RUNTIME_LIVENESS_STALE');
  fresh(runtime.updatedAt, instant, 'RECOVERY_RUNTIME_UPDATE_STALE');
  if (!object(managed) || managed.schemaVersion !== 1 || managed.state !== 'running' || managed.healthy !== true
    || managed.pid !== input.parentPid || managed.instanceToken !== input.instanceId) fail('RECOVERY_MANAGED_INSTANCE_CHANGED');
  fresh(managed.livenessAt, instant, 'RECOVERY_MANAGED_LIVENESS_STALE');
  const coordinator = managed.coordinator;
  if (!object(coordinator) || coordinator.running !== true || coordinator.nativeHealthy !== true) {
    fail('RECOVERY_COORDINATOR_HEALTH_UNKNOWN');
  }
  if (managed.controlBusy !== false || coordinator.transactionActive !== false || coordinator.activeHttp !== 0
    || coordinator.pendingControl !== 0) fail('RECOVERY_CONTROL_NOT_QUIESCENT');
  if (!Array.isArray(coordinator.threads) || !Array.isArray(coordinator.workers)) fail('RECOVERY_COORDINATOR_RECORDS_MISSING');
  for (const thread of coordinator.threads) {
    if (!object(thread) || thread.phase !== 'terminal' || thread.activeHttp !== 0 || thread.activationError) fail('RECOVERY_THREAD_NOT_TERMINAL');
  }
  const hashes = expectedHashes(profile);
  const sources = workerSources ?? [hashes];
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 5) fail('RECOVERY_EXPECTED_SOURCE_HASHES_MISSING');
  for (const source of sources) expectedHashes({ initial: { expectedHashes: source } });
  if (coordinator.activation !== null) {
    const activation = coordinator.activation;
    if (!workerSources || !object(activation) || typeof activation.activationId !== 'string' || !activation.activationId
      || typeof activation.active !== 'boolean' || !Array.isArray(activation.deferredThreadIds)
      || activation.deferredThreadIds.some(threadId => !coordinator.threads.some(thread => thread.threadId === threadId))
      || coordinator.threads.some(thread => thread.pendingActivationId && thread.pendingActivationId !== activation.activationId)
      || !coordinator.workers.some(worker => worker.workerId === activation.sourceWorkerId)
      || !coordinator.workers.some(worker => worker.workerId === activation.targetWorkerId)) fail('RECOVERY_CONTROL_NOT_QUIESCENT');
  }
  const indexed = processIndex(processes);
  const bindings = assertBindings(input.processBindings, indexed, input.parentPid, input.appServerPid);
  const app = indexed.get(input.appServerPid);
  if (app.parentPid !== input.parentPid || !/app-server/iu.test(app.commandLine)) fail('RECOVERY_APP_PARENT_CHANGED');
  assertNoDesktop(indexed, input.appServerPid);
  const ownedTree = descendants(new Set([input.parentPid]), indexed);
  const workerIds = new Set();
  const workerPids = new Set();
  for (const worker of coordinator.workers) {
    if (!object(worker) || typeof worker.workerId !== 'string' || !worker.workerId.trim()
      || workerIds.has(worker.workerId) || !positivePid(worker.pid) || workerPids.has(worker.pid)
      || worker.pid === input.parentPid || worker.pid === input.appServerPid
      || typeof worker.alive !== 'boolean' || typeof worker.ready !== 'boolean'
      || typeof worker.retired !== 'boolean' || worker.cleanupPending !== false) fail('RECOVERY_WORKER_UNKNOWN');
    workerIds.add(worker.workerId);
    workerPids.add(worker.pid);
    if (!worker.alive) {
      if (worker.ready || !worker.retired || indexed.has(worker.pid)) fail('RECOVERY_RETIRED_WORKER_UNRESOLVED');
      continue;
    }
    if (!worker.ready || (worker.retired && !workerSources) || !indexed.has(worker.pid) || !ownedTree.has(worker.pid)) fail('RECOVERY_WORKER_RELATION_UNKNOWN');
    if (!object(worker.sourceHashes) || Object.keys(worker.sourceHashes).length !== Object.keys(hashes).length
      || !sources.some(source => Object.entries(source).every(([name, value]) => worker.sourceHashes[name] === value))) fail('RECOVERY_WORKER_SOURCE_CHANGED');
    bindings.add(worker.pid);
  }
  const captured = descendants(bindings, indexed);
  const parentExecutable = executable(indexed.get(input.parentPid).executablePath);
  for (const processId of captured) {
    const process = indexed.get(processId);
    assertProcessIdentity(process);
    if (!bindings.has(processId) && (executable(process.executablePath) === parentExecutable
      || win32.basename(process.executablePath).toLowerCase() === 'node.exe')) fail('RECOVERY_UNREGISTERED_WORKER_PROCESS');
    if (timestamp(process.creationDate, 'RECOVERY_PROCESS_CREATION_UNKNOWN') > instant) {
      fail('RECOVERY_PROCESS_CREATION_IN_FUTURE');
    }
  }
  const ports = new Set([Number(control.port)]);
  const observedListeners = checkedListeners(listeners);
  let controlObserved = false;
  for (const listener of observedListeners) {
    if (!indexed.has(listener.owningProcess)) fail('RECOVERY_LISTENER_OWNER_UNKNOWN');
    if (listener.localPort === Number(control.port)) {
      if (listener.owningProcess !== input.parentPid) fail('RECOVERY_CONTROL_LISTENER_CHANGED');
      controlObserved = true;
    }
    if (captured.has(listener.owningProcess)) ports.add(listener.localPort);
  }
  if (!controlObserved) fail('RECOVERY_CONTROL_LISTENER_MISSING');
  return {
    schemaVersion: 1,
    observedAt: new Date(instant).toISOString(),
    expiresAt: new Date(Math.min(Date.parse(runtime.livenessAt), Date.parse(runtime.updatedAt), Date.parse(managed.livenessAt)) + freshnessMs).toISOString(),
    parentPid: input.parentPid,
    appServerPid: input.appServerPid,
    instanceIdSha256: digest(input.instanceId),
    workerPids: [...workerPids].filter(processId => indexed.has(processId)).sort((left, right) => left - right),
    capturedProcesses: [...captured].sort((left, right) => left - right).map(processId => capture(indexed.get(processId))),
    ports: [...ports].sort((left, right) => left - right),
  };
}

export function assertRecoveryExited({ capturedProcesses, processes, listeners, ports } = {}) {
  if (!Array.isArray(capturedProcesses) || capturedProcesses.length < 2) fail('RECOVERY_CAPTURE_MISSING');
  const captured = new Set();
  for (const process of capturedProcesses) {
    if (!object(process) || !positivePid(process.pid) || captured.has(process.pid)
      || !Number.isSafeInteger(process.parentPid) || process.parentPid < 0 || process.parentPid === process.pid
      || typeof process.commandLineSha256 !== 'string' || !hashPattern.test(process.commandLineSha256)) fail('RECOVERY_CAPTURE_INVALID');
    timestamp(process.creationDate, 'RECOVERY_CAPTURE_INVALID');
    executable(process.executablePath);
    captured.add(process.pid);
  }
  if (!Array.isArray(ports) || ports.length === 0 || ports.some(port => !portNumber(port))
    || new Set(ports).size !== ports.length) fail('RECOVERY_PORTS_MISSING_OR_INVALID');
  const indexed = processIndex(processes);
  for (const process of indexed.values()) {
    if (captured.has(process.pid)) fail('RECOVERY_CAPTURED_PROCESS_REMAINS');
    if (captured.has(process.parentPid)) fail('RECOVERY_DESCENDANT_REMAINS');
  }
  assertNoDesktop(indexed, null);
  for (const listener of checkedListeners(listeners)) {
    if (ports.includes(listener.localPort)) fail('RECOVERY_PORT_STILL_LISTENING');
    if (captured.has(listener.owningProcess)) fail('RECOVERY_CAPTURED_LISTENER_REMAINS');
    if (!indexed.has(listener.owningProcess)) fail('RECOVERY_LISTENER_OWNER_UNKNOWN');
  }
  return { exited: true, capturedProcessCount: captured.size, ports: [...ports] };
}
