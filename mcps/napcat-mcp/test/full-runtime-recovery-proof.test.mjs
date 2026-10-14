import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertRecoveryQuiescent, assertRecoveryExited } from '../ops/full-runtime-recovery-proof.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const instant = '2030-01-02T03:04:05.000Z';

function fixture() {
  const sourceHashes = Object.fromEntries(['runner', 'core', 'helper', 'control'].map(name => [name, digest(name)]));
  const makeProcess = (pid, parentPid, executablePath, commandLine) => ({
    pid, parentPid, creationDate: '2030-01-02T03:00:00.000Z', executablePath, commandLine,
  });
  const processes = [
    makeProcess(100, 1, 'C:\\fixture\\node.exe', 'node fixture-parent --token synthetic-secret'),
    makeProcess(101, 100, 'C:\\fixture\\codex.exe', 'codex app-server --listen fixture'),
    makeProcess(102, 100, 'C:\\fixture\\node.exe', 'node fixture-worker'),
    makeProcess(103, 102, 'C:\\fixture\\helper.exe', 'helper fixture-child'),
    makeProcess(104, 103, 'C:\\fixture\\helper.exe', 'helper fixture-grandchild'),
    makeProcess(900, 1, 'C:\\fixture\\unrelated.exe', 'unrelated fixture'),
  ];
  const input = {
    parentPid: 100, appServerPid: 101, instanceId: 'synthetic-instance', controlUrl: 'http://127.0.0.1:18431',
    processBindings: processes.slice(0, 2).map(process => ({
      pid: process.pid, creationDate: process.creationDate, executablePath: process.executablePath,
      commandLineSha256: digest(process.commandLine),
    })),
  };
  return {
    input,
    profile: { initial: { expectedHashes: sourceHashes } },
    runtime: { pid: 100, appServerPid: 101, instanceToken: input.instanceId, controlUrl: input.controlUrl,
      state: 'running', livenessAt: instant, updatedAt: instant },
    managed: { schemaVersion: 1, state: 'running', healthy: true, pid: 100, instanceToken: input.instanceId,
      livenessAt: instant, controlBusy: false, coordinator: { running: true, nativeHealthy: true,
        transactionActive: false, activeHttp: 0, pendingControl: 0, activation: null,
        threads: [{ phase: 'terminal', activeHttp: 0 }],
        workers: [{ workerId: 'synthetic-worker', pid: 102, ready: true, alive: true,
          sourceHashes: { ...sourceHashes }, retired: false, cleanupPending: false }] } },
    processes,
    listeners: [{ localPort: 18431, owningProcess: 100, state: 'Listen' },
      { localPort: 18435, owningProcess: 102, state: 'Listen' }],
    now: instant,
  };
}

function refuses(mutator, code) {
  const snapshot = fixture();
  mutator(snapshot);
  assert.throws(() => assertRecoveryQuiescent(snapshot), error => error.code === code);
}

test('registered changed-source workers and idle activation can be stopped without treating another source as trusted', () => {
  const snapshot = fixture();
  const worker = snapshot.managed.coordinator.workers[0];
  const changed = { ...worker.sourceHashes, control: digest('changed-control') };
  snapshot.workerSources = [snapshot.profile.initial.expectedHashes, changed];
  worker.sourceHashes = changed;
  worker.retired = true;
  snapshot.managed.coordinator.activation = { activationId: 'completed-activation', active: true,
    sourceWorkerId: worker.workerId, targetWorkerId: worker.workerId, deferredThreadIds: [] };
  assert.deepEqual(assertRecoveryQuiescent(snapshot).workerPids, [102]);
  worker.sourceHashes = { ...changed, core: digest('unregistered-core') };
  assert.throws(() => assertRecoveryQuiescent(snapshot), /RECOVERY_WORKER_SOURCE_CHANGED/);
});

test('registered source does not permit pending requests or an unknown deferred thread', () => {
  const snapshot = fixture();
  snapshot.workerSources = [snapshot.profile.initial.expectedHashes];
  snapshot.managed.coordinator.activeHttp = 1;
  assert.throws(() => assertRecoveryQuiescent(snapshot), /RECOVERY_CONTROL_NOT_QUIESCENT/);
  snapshot.managed.coordinator.activeHttp = 0;
  snapshot.managed.coordinator.activation = { activationId: 'unfinished', active: true,
    sourceWorkerId: 'synthetic-worker', targetWorkerId: 'synthetic-worker', deferredThreadIds: ['unknown'] };
  assert.throws(() => assertRecoveryQuiescent(snapshot), /RECOVERY_CONTROL_NOT_QUIESCENT/);
});

test('quiescent proof captures all descendants, hashes commands and does not mutate input', () => {
  const snapshot = fixture();
  const before = clone(snapshot);
  const proof = assertRecoveryQuiescent(snapshot);
  assert.deepEqual(proof.capturedProcesses.map(process => process.pid), [100, 101, 102, 103, 104]);
  assert.deepEqual(proof.workerPids, [102]);
  assert.deepEqual(proof.ports, [18431, 18435]);
  assert.equal(proof.expiresAt, '2030-01-02T03:04:15.000Z');
  assert.ok(!JSON.stringify(proof).includes('synthetic-secret'));
  assert.ok(proof.capturedProcesses.every(process => !Object.hasOwn(process, 'commandLine')));
  assert.deepEqual(snapshot, before);
});

for (const [name, mutator, code] of [
  ['old runtime heartbeat', snapshot => { snapshot.runtime.livenessAt = '2030-01-02T03:03:54.999Z'; }, 'RECOVERY_RUNTIME_LIVENESS_STALE'],
  ['old managed heartbeat', snapshot => { snapshot.managed.livenessAt = '2030-01-02T03:03:54.999Z'; }, 'RECOVERY_MANAGED_LIVENESS_STALE'],
  ['future heartbeat', snapshot => { snapshot.runtime.updatedAt = '2030-01-02T03:04:05.001Z'; }, 'RECOVERY_RUNTIME_UPDATE_STALE'],
  ['missing heartbeat', snapshot => { delete snapshot.managed.livenessAt; }, 'RECOVERY_MANAGED_LIVENESS_STALE'],
  ['invalid calendar date', snapshot => { snapshot.managed.livenessAt = '2030-02-31T03:04:05.000Z'; }, 'RECOVERY_MANAGED_LIVENESS_STALE'],
  ['wrong parent instance', snapshot => { snapshot.runtime.instanceToken = 'changed'; }, 'RECOVERY_RUNTIME_INSTANCE_CHANGED'],
  ['wrong managed instance', snapshot => { snapshot.managed.pid = 999; }, 'RECOVERY_MANAGED_INSTANCE_CHANGED'],
  ['wrong control URL', snapshot => { snapshot.runtime.controlUrl = 'http://127.0.0.1:19000'; }, 'RECOVERY_RUNTIME_INSTANCE_CHANGED'],
  ['nonterminal thread', snapshot => { snapshot.managed.coordinator.threads[0].phase = 'running'; }, 'RECOVERY_THREAD_NOT_TERMINAL'],
  ['thread request active', snapshot => { snapshot.managed.coordinator.threads[0].activeHttp = 1; }, 'RECOVERY_THREAD_NOT_TERMINAL'],
  ['global request active', snapshot => { snapshot.managed.coordinator.activeHttp = 1; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['pending control', snapshot => { snapshot.managed.coordinator.pendingControl = 1; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['control busy', snapshot => { snapshot.managed.controlBusy = true; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['transaction active', snapshot => { snapshot.managed.coordinator.transactionActive = true; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['activation active or unknown', snapshot => { snapshot.managed.coordinator.activation = { phase: 'activating' }; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['missing zero counter', snapshot => { delete snapshot.managed.coordinator.pendingControl; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['missing activation', snapshot => { delete snapshot.managed.coordinator.activation; }, 'RECOVERY_CONTROL_NOT_QUIESCENT'],
  ['missing worker records', snapshot => { delete snapshot.managed.coordinator.workers; }, 'RECOVERY_COORDINATOR_RECORDS_MISSING'],
  ['unhealthy coordinator', snapshot => { snapshot.managed.coordinator.nativeHealthy = false; }, 'RECOVERY_COORDINATOR_HEALTH_UNKNOWN'],
  ['unknown worker pid', snapshot => { snapshot.managed.coordinator.workers[0].pid = 998; }, 'RECOVERY_WORKER_RELATION_UNKNOWN'],
  ['worker source drift', snapshot => { snapshot.managed.coordinator.workers[0].sourceHashes.core = digest('changed'); }, 'RECOVERY_WORKER_SOURCE_CHANGED'],
  ['worker source missing', snapshot => { delete snapshot.managed.coordinator.workers[0].sourceHashes.control; }, 'RECOVERY_WORKER_SOURCE_CHANGED'],
  ['worker cleanup pending', snapshot => { snapshot.managed.coordinator.workers[0].cleanupPending = true; }, 'RECOVERY_WORKER_UNKNOWN'],
  ['worker relationship changed', snapshot => { snapshot.processes[2].parentPid = 900; }, 'RECOVERY_WORKER_RELATION_UNKNOWN'],
  ['unregistered node descendant', snapshot => { snapshot.processes[3].executablePath = 'C:\\fixture\\node.exe'; }, 'RECOVERY_UNREGISTERED_WORKER_PROCESS'],
  ['recycled parent pid', snapshot => { snapshot.processes[0].creationDate = '2030-01-02T03:01:00.000Z'; }, 'RECOVERY_PROCESS_BINDING_CHANGED'],
  ['changed executable', snapshot => { snapshot.processes[1].executablePath = 'C:\\fixture\\foreign.exe'; }, 'RECOVERY_PROCESS_BINDING_CHANGED'],
  ['changed command', snapshot => { snapshot.processes[0].commandLine += ' changed'; }, 'RECOVERY_PROCESS_BINDING_CHANGED'],
  ['missing app binding', snapshot => { snapshot.input.processBindings.pop(); }, 'RECOVERY_PROCESS_BINDINGS_MISSING'],
  ['duplicate binding', snapshot => { snapshot.input.processBindings.push(clone(snapshot.input.processBindings[0])); }, 'RECOVERY_PROCESS_BINDING_INVALID'],
  ['duplicate process pid', snapshot => { snapshot.processes.push(clone(snapshot.processes[0])); }, 'RECOVERY_PROCESS_RELATION_UNKNOWN'],
  ['missing target descendant command', snapshot => { snapshot.processes[3].commandLine = null; }, 'RECOVERY_PROCESS_COMMAND_UNKNOWN'],
  ['missing target descendant executable', snapshot => { snapshot.processes[3].name = 'helper.exe'; snapshot.processes[3].executablePath = null; }, 'RECOVERY_PROCESS_EXECUTABLE_UNKNOWN'],
  ['missing target descendant creation', snapshot => { snapshot.processes[3].creationDate = null; }, 'RECOVERY_PROCESS_CREATION_UNKNOWN'],
  ['unidentified opaque process', snapshot => { snapshot.processes[5].executablePath = null; }, 'RECOVERY_DESKTOP_IDENTITY_UNKNOWN'],
  ['opaque Codex process', snapshot => { snapshot.processes[5].name = 'Codex.exe'; snapshot.processes[5].executablePath = null; snapshot.processes[5].commandLine = null; }, 'RECOVERY_DESKTOP_IDENTITY_UNKNOWN'],
  ['app parent changed', snapshot => { snapshot.processes[1].parentPid = 900; }, 'RECOVERY_APP_PARENT_CHANGED'],
  ['child predates parent', snapshot => { snapshot.processes[3].creationDate = '2029-01-02T03:00:00.000Z'; }, 'RECOVERY_PROCESS_PARENT_REUSED'],
  ['process relation cycle', snapshot => { snapshot.processes[0].parentPid = 104; }, 'RECOVERY_PROCESS_RELATION_UNKNOWN'],
  ['unknown listener owner', snapshot => { snapshot.listeners.push({ localPort: 19999, owningProcess: 999, state: 'Listen' }); }, 'RECOVERY_LISTENER_OWNER_UNKNOWN'],
  ['control listener hijacked', snapshot => { snapshot.listeners[0].owningProcess = 900; }, 'RECOVERY_CONTROL_LISTENER_CHANGED'],
  ['control listener missing', snapshot => { snapshot.listeners.shift(); }, 'RECOVERY_CONTROL_LISTENER_MISSING'],
  ['missing listener state', snapshot => { delete snapshot.listeners[0].state; }, 'RECOVERY_LISTENER_UNKNOWN'],
  ['desktop still open', snapshot => { snapshot.processes[5].executablePath = 'C:\\fixture\\Codex.exe'; }, 'RECOVERY_DESKTOP_RUNNING'],
  ['unbound app server', snapshot => { snapshot.processes[5].executablePath = 'C:\\fixture\\codex.exe'; snapshot.processes[5].commandLine = 'codex app-server'; }, 'RECOVERY_UNBOUND_APP_SERVER'],
]) {
  test(`quiescence refuses ${name}`, () => refuses(mutator, code));
}

test('ten second inclusive boundary and case-insensitive Windows executable binding', () => {
  const snapshot = fixture();
  snapshot.runtime.livenessAt = '2030-01-02T03:03:55.000Z';
  snapshot.input.processBindings[0].executablePath = 'c:/FIXTURE/NODE.EXE';
  const proof = assertRecoveryQuiescent(snapshot);
  assert.equal(proof.parentPid, 100);
  assert.equal(proof.expiresAt, instant);
});

test('oldest heartbeat determines remaining proof lifetime', () => {
  const snapshot = fixture();
  snapshot.managed.livenessAt = '2030-01-02T03:04:02.000Z';
  assert.equal(assertRecoveryQuiescent(snapshot).expiresAt, '2030-01-02T03:04:12.000Z');
});

test('known retired worker must actually be absent and has no live worker claim', () => {
  const snapshot = fixture();
  snapshot.managed.coordinator.workers.push({ workerId: 'retired', pid: 500, alive: false, ready: false, retired: true, cleanupPending: false });
  assert.deepEqual(assertRecoveryQuiescent(snapshot).workerPids, [102]);
  snapshot.processes.push({ ...snapshot.processes[5], pid: 500 });
  assert.throws(() => assertRecoveryQuiescent(snapshot), { code: 'RECOVERY_RETIRED_WORKER_UNRESOLVED' });
});

test('unrelated protected OS records preserve null fields and permit both proofs', () => {
  const snapshot = fixture();
  const system = { pid: 4, parentPid: 0, name: 'System', creationDate: null, executablePath: null, commandLine: null };
  const service = { pid: 700, parentPid: 4, name: 'svchost.exe', creationDate: null, executablePath: null, commandLine: null };
  snapshot.processes.push(system, service);
  const before = clone(snapshot);
  const proof = assertRecoveryQuiescent(snapshot);
  assert.equal(assertRecoveryExited({ capturedProcesses: proof.capturedProcesses, processes: [system, service], listeners: [], ports: proof.ports }).exited, true);
  assert.deepEqual(snapshot, before);
});

function exitedFixture() {
  const snapshot = fixture();
  const proof = assertRecoveryQuiescent(snapshot);
  return { capturedProcesses: proof.capturedProcesses, processes: [snapshot.processes[5]], listeners: [], ports: proof.ports };
}

test('all captured processes and ports exited passes without altering evidence', () => {
  const snapshot = exitedFixture();
  const original = clone(snapshot);
  assert.deepEqual(assertRecoveryExited(snapshot), { exited: true, capturedProcessCount: 5, ports: [18431, 18435] });
  assert.deepEqual(snapshot, original);
});

test('owner IO listener projection and ISO now are accepted without command disclosure', () => {
  const snapshot = fixture();
  snapshot.listeners = snapshot.listeners.map(listener => ({ port: listener.localPort, pid: listener.owningProcess, address: '127.0.0.1' }));
  const proof = assertRecoveryQuiescent(snapshot);
  assert.equal(proof.observedAt, instant);
  assert.ok(!JSON.stringify(proof).includes('synthetic-secret'));
  const after = { capturedProcesses: proof.capturedProcesses, processes: [snapshot.processes[5]], listeners: [], ports: proof.ports };
  assert.equal(assertRecoveryExited(after).exited, true);
  after.listeners = [{ port: 18431, pid: 900, address: '::1' }];
  assert.throws(() => assertRecoveryExited(after), { code: 'RECOVERY_PORT_STILL_LISTENING' });
});

test('owner IO missing address and mixed listener projections refuse', () => {
  const snapshot = fixture();
  snapshot.listeners = [{ port: 18431, pid: 100 }];
  assert.throws(() => assertRecoveryQuiescent(snapshot), { code: 'RECOVERY_LISTENER_UNKNOWN' });
  snapshot.listeners[0] = { port: 18431, pid: 100, address: '127.0.0.1', localPort: 19999 };
  assert.throws(() => assertRecoveryQuiescent(snapshot), { code: 'RECOVERY_LISTENER_UNKNOWN' });
});

for (const [name, mutator, code] of [
  ['parent remains', snapshot => { snapshot.processes.push(fixture().processes[0]); }, 'RECOVERY_CAPTURED_PROCESS_REMAINS'],
  ['grandchild remains', snapshot => { snapshot.processes.push(fixture().processes[4]); }, 'RECOVERY_CAPTURED_PROCESS_REMAINS'],
  ['captured pid reused', snapshot => { snapshot.processes.push({ ...fixture().processes[4], creationDate: instant, commandLine: 'different-process' }); }, 'RECOVERY_CAPTURED_PROCESS_REMAINS'],
  ['late child after capture', snapshot => { snapshot.processes.push({ ...fixture().processes[4], pid: 105, parentPid: 103 }); }, 'RECOVERY_DESCENDANT_REMAINS'],
  ['foreign listener owns target port', snapshot => { snapshot.listeners.push({ localPort: 18435, owningProcess: 900, state: 'Listen' }); }, 'RECOVERY_PORT_STILL_LISTENING'],
  ['captured owner listens on new port', snapshot => { snapshot.listeners.push({ localPort: 19999, owningProcess: 102, state: 'Listen' }); }, 'RECOVERY_CAPTURED_LISTENER_REMAINS'],
  ['unresolved listener owner', snapshot => { snapshot.listeners.push({ localPort: 19999, owningProcess: 999, state: 'Listen' }); }, 'RECOVERY_LISTENER_OWNER_UNKNOWN'],
  ['Desktop reopens during shutdown', snapshot => { snapshot.processes[0].executablePath = 'C:\\fixture\\Codex.exe'; }, 'RECOVERY_DESKTOP_RUNNING'],
  ['missing process snapshot', snapshot => { delete snapshot.processes; }, 'RECOVERY_PROCESS_SNAPSHOT_MISSING'],
  ['missing listener snapshot', snapshot => { delete snapshot.listeners; }, 'RECOVERY_LISTENER_SNAPSHOT_MISSING'],
  ['empty capture', snapshot => { snapshot.capturedProcesses = []; }, 'RECOVERY_CAPTURE_MISSING'],
  ['missing port set', snapshot => { snapshot.ports = []; }, 'RECOVERY_PORTS_MISSING_OR_INVALID'],
]) {
  test(`exit proof refuses ${name}`, () => {
    const snapshot = exitedFixture();
    mutator(snapshot);
    assert.throws(() => assertRecoveryExited(snapshot), error => error.code === code);
  });
}
