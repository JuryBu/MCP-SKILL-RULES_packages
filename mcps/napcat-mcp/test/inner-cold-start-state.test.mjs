import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { acquireInnerColdStart } from "../src/inner-cold-start-state.mjs";
import { createModelOperationLedger } from "../src/model-operation-ledger.mjs";

const windows = process.platform === "win32";
const operationFile = "codex-model-operation-state.json";
const markerFile = ".inner-worker-owner.json";
const born = "2026-10-23T10:00:00.1234567Z";
const runner = '"C:\\Program Files\\nodejs\\node.exe" "C:\\runtime candidate\\src\\codex-model-stream-proxy-runner.mjs"';

function fixture(context, specifications = [{}]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-cold-身份 "));
  const guards = [];
  context.after(() => {
    for (const guard of guards) guard.release();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binding = { stateRoot: root, ownerId: "identity-test", nativeSourceId: "identity-test-native" };
  const sessionId = crypto.randomUUID();
  const guard = acquireInnerColdStart({ ...binding, sessionId });
  guards.push(guard);
  const workers = specifications.map((specification, index) => {
    const workerId = `${sessionId}-worker-${index + 1}`;
    const workerRoot = path.join(root, workerId);
    guard.seed(workerRoot, workerId);
    const markerPath = path.join(workerRoot, markerFile);
    const marker = { ...JSON.parse(fs.readFileSync(markerPath, "utf8")), phase: "started", pid: 61001 + index, ...specification };
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    const ledger = createModelOperationLedger();
    ledger.begin(`thread-${index}\u0000operation-${index}`);
    const ledgerPath = path.join(workerRoot, operationFile);
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger.snapshot()));
    return { ...marker, workerRoot, markerPath, ledgerPath, originalLedger: fs.readFileSync(ledgerPath, "utf8") };
  });
  guard.release();
  const reopen = () => {
    const next = acquireInnerColdStart({ ...binding, sessionId: crypto.randomUUID() });
    guards.push(next);
    return next;
  };
  return { root, binding, sessionId, guard, workers, reopen };
}

function observation(pid, overrides = {}) {
  return { ProcessId: pid, ParentProcessId: process.pid, Name: "node.exe", CommandLine: runner, CreationDate: born, ...overrides };
}

function windowsSnapshot(context, records, { alive = records.map(record => record.ProcessId), result } = {}) {
  let calls = 0;
  mock.method(process, "kill", (pid, signal) => {
    assert.equal(signal, 0);
    if (alive.includes(pid)) return true;
    throw Object.assign(new Error("missing"), { code: "ESRCH" });
  });
  mock.method(childProcess, "spawnSync", (_executable, _arguments, options) => {
    calls += 1;
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 12000);
    assert.ok(options.maxBuffer <= 4194304);
    return result ?? { status: 0, stdout: JSON.stringify({ complete: true, processes: records }) };
  });
  syncBuiltinESMExports();
  context.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  return () => calls;
}

function unchanged(workers) {
  for (const worker of workers) assert.equal(fs.readFileSync(worker.ledgerPath, "utf8"), worker.originalLedger);
}

test("dead historical workers use kill0 without a process snapshot and preserve UNKNOWN", context => {
  const setup = fixture(context, [{}, {}]);
  const calls = windowsSnapshot(context, []);
  const next = setup.reopen();
  context.after(() => next.release());
  assert.equal(calls(), 0);
  assert.equal(next.status.recoveredWorkers, 2);
  assert.equal(next.status.protectedOperations, 2);
  const workerId = `${next.status.sessionId}-worker-1`;
  const workerRoot = path.join(setup.root, workerId);
  next.seed(workerRoot, workerId);
  const restored = JSON.parse(fs.readFileSync(path.join(workerRoot, operationFile), "utf8"));
  assert.ok(restored.entries.every(([, entry]) => entry.acceptance === "unknown" && entry.phase === "unresolved"));
  assert.throws(() => createModelOperationLedger({ state: restored }).begin("thread-0\u0000operation-0"),
    { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
  unchanged(setup.workers);
});

test("recorded Windows birth distinguishes a reused PID, including another runner", { skip: !windows }, context => {
  const setup = fixture(context, [{ processIdentity: { platform: "win32", createdAt: born } }]);
  const calls = windowsSnapshot(context, [observation(61001, { CreationDate: "2026-10-23T10:01:00.1234567Z" })]);
  const next = setup.reopen();
  context.after(() => next.release());
  assert.equal(calls(), 1);
  assert.equal(next.status.protectedOperations, 1);
  assert.equal(next.status.ignoredWorkerPids[0].reason, "creation_time_changed");
  assert.equal(next.status.ignoredWorkerPids[0].pid, 61001);
  assert.equal(next.status.ignoredWorkerPids[0].workerId, setup.workers[0].workerId);
  unchanged(setup.workers);
});

test("matching birth blocks a live worker even when its session is closed", { skip: !windows }, context => {
  const setup = fixture(context, [{ processIdentity: { platform: "win32", createdAt: born } }]);
  windowsSnapshot(context, [observation(61001)]);
  assert.throws(setup.reopen, error => error.code === "COLD_START_OLD_WORKER_ALIVE"
    && error.details.pid === 61001 && error.details.workerId === setup.workers[0].workerId
    && error.message.includes(setup.workers[0].workerId) && error.message.includes("61001"));
  unchanged(setup.workers);
});

test("legacy marker identifies an unrelated launcher and keeps its UNKNOWN ledger", { skip: !windows }, context => {
  const setup = fixture(context);
  windowsSnapshot(context, [observation(61001, { CommandLine: '"C:\\node.exe" "C:\\runtime\\launcher.mjs"' })]);
  const next = setup.reopen();
  context.after(() => next.release());
  assert.equal(next.status.recoveredWorkers, 1);
  assert.equal(next.status.ignoredWorkerPids[0].reason, "different_process_command");
  unchanged(setup.workers);
});

test("legacy snapshot is shared across live markers and ignores a non-node process", { skip: !windows }, context => {
  const setup = fixture(context, [{}, {}]);
  const calls = windowsSnapshot(context, [observation(61001, { Name: "powershell.exe", CommandLine: null }),
    observation(61002, { CommandLine: '"C:\\node.exe" "C:\\runtime\\launcher.mjs"' })]);
  const next = setup.reopen();
  context.after(() => next.release());
  assert.equal(calls(), 1);
  assert.equal(next.status.recoveredWorkers, 2);
  unchanged(setup.workers);
});

test("legacy runner stays blocked without a command-line workerId", { skip: !windows }, context => {
  const setup = fixture(context);
  windowsSnapshot(context, [observation(61001)]);
  assert.throws(setup.reopen, { code: "COLD_START_OLD_WORKER_ALIVE" });
  unchanged(setup.workers);
});

test("legacy runner paths remain protected with a renamed node executable", { skip: !windows }, context => {
  const setup = fixture(context);
  windowsSnapshot(context, [observation(61001, { Name: "custom-node.exe",
    CommandLine: '"C:\\custom-node.exe" --no-warnings "C:\\candidate\\codex-model-stream-proxy-runner.mjs"' })]);
  assert.throws(setup.reopen, { code: "COLD_START_OLD_WORKER_ALIVE" });
});

test("legacy time evidence can prove a PID was born after its durable marker", { skip: !windows }, context => {
  const setup = fixture(context);
  fs.utimesSync(setup.workers[0].markerPath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  windowsSnapshot(context, [observation(61001, { CommandLine: null })]);
  const next = setup.reopen();
  context.after(() => next.release());
  assert.equal(next.status.ignoredWorkerPids[0].reason, "created_after_marker");
  unchanged(setup.workers);
});

test("unknown Windows observations fail closed and leave historical ledgers untouched", { skip: !windows }, async context => {
  for (const result of [
    { status: 1, stdout: "" },
    { status: 0, stdout: "not json" },
    { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null, stdout: "" },
    { status: 0, stdout: JSON.stringify({ complete: false, processes: [] }) },
    { status: 0, stdout: JSON.stringify({ complete: true, processes: [] }) },
    { status: 0, stdout: JSON.stringify({ complete: true, processes: [observation(61001, { CommandLine: null, CreationDate: null })] }) },
    { status: 0, stdout: JSON.stringify({ complete: true, processes: [observation(61001, { CommandLine: '"C:\\node.exe" "C:\\unclosed runner.mjs', CreationDate: null })] }) },
    { status: 0, stdout: JSON.stringify({ complete: true, processes: [observation(61001, { CommandLine: '"C:\\node.exe" --require "C:\\loader.mjs" "C:\\codex-model-stream-proxy-runner.mjs"', CreationDate: null })] }) },
  ]) {
    await context.test(JSON.stringify(result), subcontext => {
      const setup = fixture(subcontext);
      windowsSnapshot(subcontext, [], { alive: [61001], result });
      assert.throws(setup.reopen, error => error.code === "COLD_START_PROCESS_STATE_UNKNOWN"
        && error.details.pid === 61001 && error.details.workerId === setup.workers[0].workerId);
      unchanged(setup.workers);
    });
  }
});

test("a persisted identity never falls back to command classification when birth is unreadable", { skip: !windows }, context => {
  const setup = fixture(context, [{ processIdentity: { platform: "win32", createdAt: born } }]);
  windowsSnapshot(context, [observation(61001, { Name: "powershell.exe", CreationDate: null })]);
  assert.throws(setup.reopen, { code: "COLD_START_PROCESS_STATE_UNKNOWN" });
  unchanged(setup.workers);
});

test("malformed recorded birth remains protected", { skip: !windows }, context => {
  const setup = fixture(context, [{ processIdentity: { platform: "win32", createdAt: "invalid" } }]);
  windowsSnapshot(context, [observation(61001)]);
  assert.throws(setup.reopen, { code: "COLD_START_PROCESS_STATE_UNKNOWN" });
});

test("started captures only the observed child birth, with a PID-targeted snapshot", { skip: !windows }, context => {
  const setup = fixture(context, []);
  const next = setup.reopen();
  const calls = windowsSnapshot(context, [observation(61001)]);
  const workerId = `${next.status.sessionId}-worker-1`;
  const workerRoot = path.join(setup.root, workerId);
  next.seed(workerRoot, workerId);
  next.started(workerRoot, workerId, 61001);
  const marker = JSON.parse(fs.readFileSync(path.join(workerRoot, markerFile), "utf8"));
  assert.deepEqual(marker.processIdentity, { platform: "win32", createdAt: born });
  assert.equal(calls(), 1);
  assert.ok(childProcess.spawnSync.mock.calls[0].arguments[1].at(-1).includes("-Filter 'ProcessId = 61001'"));
});

test("started never binds a replacement PID owned by another parent", { skip: !windows }, context => {
  const setup = fixture(context, []);
  const next = setup.reopen();
  windowsSnapshot(context, [observation(61001, { ParentProcessId: process.pid + 1 })]);
  const workerId = `${next.status.sessionId}-worker-1`;
  const workerRoot = path.join(setup.root, workerId);
  next.seed(workerRoot, workerId);
  next.started(workerRoot, workerId, 61001);
  const marker = JSON.parse(fs.readFileSync(path.join(workerRoot, markerFile), "utf8"));
  assert.equal(marker.processIdentity, null);
});

test("prepared workers and unreadable kill0 stay protected", async context => {
  await context.test("prepared", subcontext => {
    const setup = fixture(subcontext, [{ phase: "prepared", pid: null }]);
    assert.throws(setup.reopen, { code: "COLD_START_WORKER_START_UNRESOLVED" });
    unchanged(setup.workers);
  });
  await context.test("kill0 access error", subcontext => {
    const setup = fixture(subcontext);
    mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    subcontext.after(() => mock.restoreAll());
    assert.throws(setup.reopen, { code: "COLD_START_PROCESS_STATE_UNKNOWN" });
    unchanged(setup.workers);
  });
});

test("live non-Windows historical PIDs retain conservative compatibility", { skip: windows }, context => {
  const setup = fixture(context, [{ pid: process.pid }]);
  assert.throws(setup.reopen, { code: "COLD_START_OLD_WORKER_ALIVE" });
});

test("real isolated runner birth is persisted, blocks while alive, and recovers after exit", { timeout: 45000 }, async context => {
  const setup = fixture(context, []);
  const next = setup.reopen();
  const workerId = `${next.status.sessionId}-worker-1`;
  const workerRoot = path.join(setup.root, workerId);
  next.seed(workerRoot, workerId);
  const script = path.join(setup.root, "codex-model-stream-proxy-runner.mjs");
  fs.writeFileSync(script, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
  const child = childProcess.spawn(process.execPath, [script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout, "data");
    next.started(workerRoot, workerId, child.pid);
    const marker = JSON.parse(fs.readFileSync(path.join(workerRoot, markerFile), "utf8"));
    if (windows) {
      assert.equal(marker.processIdentity.platform, "win32");
      assert.ok(Number.isFinite(Date.parse(marker.processIdentity.createdAt)));
    }
    const ledger = createModelOperationLedger();
    ledger.begin("real-thread\u0000unknown-operation");
    fs.writeFileSync(path.join(workerRoot, operationFile), JSON.stringify(ledger.snapshot()));
    next.release();
    assert.throws(setup.reopen, { code: "COLD_START_OLD_WORKER_ALIVE" });
    if (windows) {
      context.diagnostic(`real runner pid=${child.pid}; createdAt=${marker.processIdentity.createdAt}`);
      delete marker.processIdentity;
      fs.writeFileSync(path.join(workerRoot, markerFile), JSON.stringify(marker));
      assert.throws(setup.reopen, error => error.code === "COLD_START_OLD_WORKER_ALIVE"
        && error.details.reason === "legacy_runner_present");
    }
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    next.release();
  }
  const recovered = setup.reopen();
  context.after(() => recovered.release());
  assert.equal(recovered.status.recoveredWorkers, 1);
  assert.equal(recovered.status.protectedOperations, 1);
  context.diagnostic(`real runner pid=${child.pid}; birth captured=${windows}; after-exit protectedOperations=1`);
});

test("real Windows observation distinguishes an unrelated live process referenced by a legacy marker", { skip: !windows, timeout: 30000 }, async context => {
  const setup = fixture(context, []);
  const child = childProcess.spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout, "data");
    const next = setup.reopen();
    const workerId = `${next.status.sessionId}-worker-1`;
    const workerRoot = path.join(setup.root, workerId);
    next.seed(workerRoot, workerId);
    const markerPath = path.join(workerRoot, markerFile);
    fs.writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(markerPath, "utf8")), phase: "started", pid: child.pid }));
    next.release();
    const recovered = setup.reopen();
    try {
      assert.equal(recovered.status.recoveredWorkers, 1);
      assert.equal(recovered.status.ignoredWorkerPids[0].pid, child.pid);
      assert.equal(recovered.status.ignoredWorkerPids[0].reason, "different_process_command");
      process.kill(child.pid, 0);
      context.diagnostic(`real unrelated node pid=${child.pid}; reason=${recovered.status.ignoredWorkerPids[0].reason}; still alive`);
    } finally { recovered.release(); }
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});
