import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  buildQuickLoginArguments,
  checkNapCatRuntime,
  createSupervisorDependencies,
  findBrokerProcesses,
  findCodexProcesses,
  findNapCatProcesses,
  normalizeNapCatStatus,
  parseArguments,
  processSnapshotFingerprint,
  processTreeRootIds,
  runQuickLogin,
  runSupervisorService,
  stopWindowsProcessTrees,
  invokePowerShellScript,
  invokePowerShellCommand,
  invokeOfflineRecoveryGuard,
} from "../src/supervisor-runner.mjs";
import { loadOfflineRecoveryState, writeOfflineRecoveryBarrier } from "../src/napcat-offline-recovery.mjs";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-supervisor-test-"));
  const fixture = {
    root,
    bindingPath: path.join(root, "binding.json"),
    registryPath: path.join(root, "state", "task-registry.json"),
    runtimeStatePath: path.join(root, "state", "supervisor-runtime.json"),
    logPath: path.join(root, "state", "supervisor.jsonl"),
    stopFilePath: path.join(root, "state", "supervisor.stop"),
    lockPath: path.join(root, "state", "supervisor.lock"),
    privateEnvPath: path.join(root, "broker-private.env.json"),
    brokerStartScriptPath: path.join(root, "start-broker.ps1"),
    loginScriptPath: path.join(root, "login.ps1"),
    napcatRoot: path.join(root, "NapCat"),
    qqExePath: path.join(root, "QQ", "QQ.exe"),
    qqUserDataDir: path.join(root, "QQData", "1000000001", "QQ"),
  };
  fs.writeFileSync(fixture.bindingPath, JSON.stringify({
    expectedSelfId: "1000000001",
    expectedNickname: "ExampleBot",
    groupId: "2000000001",
  }), "utf8");
  fs.writeFileSync(fixture.privateEnvPath, JSON.stringify({
    NAPCAT_HTTP_URL: "http://127.0.0.1:3010",
    NAPCAT_ACCESS_TOKEN: "test-token",
  }), "utf8");
  return {
    ...fixture,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseOptions(fixture, overrides = {}) {
  return {
    ...fixture,
    scanIntervalMs: 10,
    probeTimeoutMs: 20,
    loginTimeoutMs: 30_000,
    loginCooldownMs: 100,
    brokerStartCooldownMs: 100,
    pid: 4101,
    now: () => new Date("2026-07-24T08:00:00.000Z"),
    installSignalHandlers: false,
    once: true,
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
    checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7003, name: "NapCat.exe" }] }),
    checkCodexProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7001, name: "Codex.exe" }] }),
    checkBrokerProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7002, name: "node.exe" }] }),
    getOpenTaskCount: async () => 1,
    routerController: {
      status() {
        return { alive: false, state: "stopped" };
      },
      ensureStarted() {
        return { started: true, pid: 5001 };
      },
    },
    ...overrides,
  };
}

function readRuntime(fixture) {
  return JSON.parse(fs.readFileSync(fixture.runtimeStatePath, "utf8"));
}

for (const proofAvailable of [true, false]) {
  test("reachable offline: durable debit precedes the only stop, or no credentials proof preserves the original", async () => {
    const fixture = createFixture();
    const originalTime = Date.parse("2026-07-24T08:00:00Z");
    const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
    let currentTime = originalTime;
    let calls = 0;
    let waits = 0;
    const originalProcess = { pid: 7003, name: "QQ.exe", creationDate: new Date(originalTime - 1000).toISOString(),
      commandLine: '"C:\\Fixture\\QQ.exe" --fixture-only' };
    try {
      const overrides = {
        once: false,
        now: () => new Date(currentTime),
        staleNapCatReachableOfflineMs: 100,
        checkNapCatStatus: async () => ({ reachable: true, runtimeStatus: { online: false, good: true },
          error: { code: "QQ_LOGIN_IDENTITY_UNAVAILABLE" } }),
        checkNapCatProcesses: async () => ({ known: true, present: true, processes: [originalProcess] }),
        checkNativeQuickLogin: async () => proofAvailable ? { fileSha256: "fixture" } : false,
        wait() {
          waits += 1;
          currentTime += 101;
          if (waits >= 2) fs.writeFileSync(fixture.stopFilePath, "fixture completed");
        },
        async offlineRecoveryGuard(request) {
          calls += 1;
          assert.equal(request.action, "recover-reachable-offline");
          assert.equal(request.root.pid, originalProcess.pid);
          const previous = JSON.parse(fs.readFileSync(barrier, "utf8"));
          assert.equal(previous.attemptAt, currentTime);
          assert.equal(previous.needsManual, true);
          assert.equal(readRuntime(fixture).login.blocked, true);
          throw new Error("fixture simulated a lost result after stop");
        },
      };
      await runSupervisorService(baseOptions(fixture, overrides));
      assert.equal(calls, proofAvailable ? 1 : 0);
      assert.equal(readRuntime(fixture).autoOfflineRecovery.needsManual, true);
      const preserved = fs.readFileSync(barrier);
      fs.unlinkSync(fixture.stopFilePath);
      fs.writeFileSync(fixture.runtimeStatePath, JSON.stringify({ login: { blocked: false } }) + "\n");
      currentTime += 24 * 60 * 60_000;
      await runSupervisorService(baseOptions(fixture, { ...overrides, once: true,
        checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }) }));
      assert.equal(calls, proofAvailable ? 1 : 0);
      assert.deepEqual(fs.readFileSync(barrier), preserved);
      assert.equal(readRuntime(fixture).actions.quickLogin.reason, "manual_login_required");
    } finally { fixture.cleanup(); }
  });
}

test("an unconfirmed guarded no-process login is not repeated after a supervisor restart", async (context) => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const touches = [];
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  const overrides = {
    checkNapCatStatus: async () => ({ known: true, reachable: false }),
    checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }),
    offlineRecoveryGuard: async request => {
      touches.push(request.action);
      assert.equal(JSON.parse(fs.readFileSync(barrier, "utf8")).needsManual, true);
      assert.equal(readRuntime(fixture).login.blocked, true);
      return { status: "unknown", changed: null, reason: "login_unverified" };
    },
  };
  await runSupervisorService(baseOptions(fixture, overrides));
  fs.writeFileSync(fixture.runtimeStatePath, "{}\n");
  await runSupervisorService(baseOptions(fixture, { ...overrides, now: () => new Date("2026-07-25T08:00:00.000Z") }));
  assert.deepEqual(touches, ["quick-login"]);
  assert.equal(readRuntime(fixture).actions.quickLogin.reason, "manual_login_required");
});

test("a confirmed no-op guard restores both durable recovery and the runtime login mark", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  const samples = [];
  await runSupervisorService(baseOptions(fixture, {
    checkNapCatStatus: async () => ({ known: true, reachable: false }),
    checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }),
    offlineRecoveryGuard: async () => {
      assert.equal(JSON.parse(fs.readFileSync(barrier, "utf8")).needsManual, true);
      assert.equal(readRuntime(fixture).login.blocked, true);
      return { status: "deferred", changed: false, reason: "maintenance_active" };
    },
    fsImpl: { ...fs, renameSync(source, target) {
      if (target === fixture.runtimeStatePath) {
        const pending = JSON.parse(fs.readFileSync(source, "utf8"));
        samples.push({ blocked: pending.login?.blocked, actions: pending.actions });
      }
      fs.renameSync(source, target);
    } },
  }));
  const reserved = samples.findIndex(sample => sample.blocked === true);
  assert.ok(reserved >= 0);
  assert.equal(samples[reserved + 1].blocked, false);
  assert.equal(samples[reserved + 1].actions.quickLogin, undefined);
  assert.equal(JSON.parse(fs.readFileSync(barrier, "utf8")).needsManual, false);
  assert.equal(readRuntime(fixture).actions.quickLogin.attempted, false);
});

for (const failedReservation of ["barrier", "runtime"]) {
  test(`a denied ${failedReservation} flush leaves recovery unsubmitted`, async context => {
    const fixture = createFixture();
    context.after(fixture.cleanup);
    const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
    const barrierTemporaryPrefix = path.join(path.dirname(barrier), "." + path.basename(barrier) + ".");
    const runtimeTemporaryPrefix = fixture.runtimeStatePath + ".tmp-";
    fs.mkdirSync(path.dirname(barrier), { recursive: true });
    writeOfflineRecoveryBarrier(barrier, loadOfflineRecoveryState());
    const prior = fs.readFileSync(barrier);
    const handles = new Map();
    let touches = 0;
    let refused = 0;
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }),
      offlineRecoveryGuard: async () => { touches += 1; throw new Error("fixture guard must not start"); },
      fsImpl: {
        ...fs,
        openSync(file, ...options) {
          const handle = fs.openSync(file, ...options);
          if (typeof file === "string") handles.set(handle, file);
          return handle;
        },
        fsyncSync(handle) {
          const file = handles.get(handle);
          if (file?.startsWith(barrierTemporaryPrefix) || file?.startsWith(runtimeTemporaryPrefix)) {
            const pending = JSON.parse(fs.readFileSync(file, "utf8"));
            if ((failedReservation === "barrier" && file.startsWith(barrierTemporaryPrefix) && pending.needsManual === true)
              || (failedReservation === "runtime" && file.startsWith(runtimeTemporaryPrefix) && pending.login?.blocked === true)) {
              refused += 1;
              throw Object.assign(new Error("fixture flush denied"), { code: "ERR_ACCESS_DENIED" });
            }
          }
          return fs.fsyncSync(handle);
        },
        closeSync(handle) {
          handles.delete(handle);
          return fs.closeSync(handle);
        },
      },
    }));
    assert.equal(refused, 1);
    assert.equal(touches, 0);
    assert.equal(readRuntime(fixture).login.blocked, false);
    assert.equal(readRuntime(fixture).actions.quickLogin.attempted, false);
    assert.deepEqual(fs.readFileSync(barrier), prior);
  });
}

test("a rejected runtime readback restores both pre-dispatch records before a later cycle or restart", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  fs.mkdirSync(path.dirname(barrier), { recursive: true });
  writeOfflineRecoveryBarrier(barrier, loadOfflineRecoveryState());
  const prior = fs.readFileSync(barrier);
  let calls = 0;
  let failNextRuntimeRead = false;
  let rejected = false;
  let recordsWhenRestored;
  const options = {
    checkNapCatStatus: async () => ({ known: true, reachable: false }),
    checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }),
    offlineRecoveryGuard: async () => {
      calls += 1;
      return { status: "deferred", changed: false, reason: "maintenance_active" };
    },
  };
  await runSupervisorService(baseOptions(fixture, { ...options, fsImpl: {
    ...fs,
    renameSync(source, target) {
      const publication = [fixture.runtimeStatePath, barrier].includes(target) ? JSON.parse(fs.readFileSync(source, "utf8")) : null;
      fs.renameSync(source, target);
      if (target === fixture.runtimeStatePath && publication.login.blocked && !rejected) failNextRuntimeRead = true;
      if (target === barrier && rejected && !publication.needsManual && !recordsWhenRestored) {
        recordsWhenRestored = [fs.readFileSync(fixture.runtimeStatePath), fs.readFileSync(barrier)];
      }
    },
    readFileSync(file, ...options) {
      if (file === fixture.runtimeStatePath && failNextRuntimeRead) {
        failNextRuntimeRead = false;
        rejected = true;
        throw Object.assign(new Error("fixture readback denied"), { code: "ERR_ACCESS_DENIED" });
      }
      return fs.readFileSync(file, ...options);
    },
  } }));
  assert.equal(rejected, true);
  assert.equal(calls, 0);
  assert.ok(recordsWhenRestored);
  assert.equal(JSON.parse(recordsWhenRestored[0]).login.blocked, false);
  assert.deepEqual(recordsWhenRestored[1], prior);
  fs.writeFileSync(fixture.runtimeStatePath, recordsWhenRestored[0]);
  fs.writeFileSync(barrier, recordsWhenRestored[1]);
  await runSupervisorService(baseOptions(fixture, { ...options, now: () => new Date("2026-07-25T08:00:00.000Z") }));
  assert.equal(calls, 1);
  assert.equal(readRuntime(fixture).actions.quickLogin.reason, "maintenance_active");
});

test("a damaged recovery record survives confirmed online and still blocks a future guarded action", async (context) => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const touches = [];
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  fs.mkdirSync(path.dirname(barrier));
  fs.writeFileSync(barrier, "incomplete\n");
  let online = true;
  let cycle = 0;
  await runSupervisorService(baseOptions(fixture, {
    once: false,
    checkNapCatStatus: async () => ({ known: true, reachable: online, online, accountMatches: online }),
    checkNapCatProcesses: async () => ({ known: true, present: online, processes: [] }),
    offlineRecoveryGuard: async request => touches.push(request.action),
    wait() {
      online = false;
      if (++cycle >= 2) fs.writeFileSync(fixture.stopFilePath, "fixture completed");
    },
  }));
  assert.deepEqual(touches, []);
  assert.equal(fs.readFileSync(barrier, "utf8"), "incomplete\n");
});

test("the opted-in development notice reserves an uncertain outcome once; training and ambiguous states never dispatch", async (context) => {
  for (const [machine, online, reachable, manualAfterVerifiedStop, count] of [
    ["development", false, true, false, 1], ["development", false, false, true, 1],
    ["development", false, false, false, 0], ["training", false, true, false, 0],
    ["development", undefined, true, false, 0],
  ]) {
    const fixture = createFixture();
    context.after(fixture.cleanup);
    const seen = [];
    const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
    fs.mkdirSync(path.dirname(barrier));
    const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
    fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: machine } }));
    fs.writeFileSync(barrier, JSON.stringify({ ...loadOfflineRecoveryState(), needsManual: true,
      manualAfterVerifiedStopAt: manualAfterVerifiedStop ? Date.parse("2026-07-24T07:59:59.000Z") : null }));
    const options = baseOptions(fixture, {
      checkNapCatStatus: async () => ({ reachable, runtimeStatus: { online, good: true } }),
      offlineRecoveryGuard: async () => { throw new Error("unexpected guard"); },
      showOfflineDesktopNotice: async (key) => {
        seen.push(key);
        const stored = JSON.parse(fs.readFileSync(barrier, "utf8"));
        assert.equal(stored.noticeAt, null);
        assert.equal(typeof stored.noticeAttemptAt, "number");
        assert.equal(readRuntime(fixture).login.blocked, true);
        assert.equal(readRuntime(fixture).actions.offlineNotice.incidentKey, key);
        throw new Error("unknown notice result");
      },
    });
    await runSupervisorService(options);
    fs.writeFileSync(fixture.runtimeStatePath, "{}\n");
    await runSupervisorService(options);
    assert.equal(seen.length, count);
    assert.equal(JSON.parse(fs.readFileSync(barrier, "utf8")).noticeAt, null);
    assert.ok(seen.every(key => /^napcat-offline-\d+$/u.test(key)));
  }
});

test("a definitively unshown notice can retry later; only display confirmation marks it shown", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  fs.mkdirSync(path.dirname(barrier));
  const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
  fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: "development" } }));
  let observedAt = Date.parse("2026-07-24T08:00:00Z");
  fs.writeFileSync(barrier, JSON.stringify({ ...loadOfflineRecoveryState(), needsManual: true, manualAfterVerifiedStopAt: observedAt - 1000 }));
  let attempts = 0;
  const options = baseOptions(fixture, {
    now: () => new Date(observedAt),
    checkNapCatStatus: async () => ({ known: true, reachable: false, online: false }),
    offlineRecoveryGuard: async () => { throw new Error("unexpected guard"); },
    showOfflineDesktopNotice: async () => ++attempts === 1 ? "notice_offline_unverified" : "notice_returned",
  });
  const readBarrier = () => JSON.parse(fs.readFileSync(barrier, "utf8"));
  await runSupervisorService(options);
  assert.equal(attempts, 1);
  assert.equal(readRuntime(fixture).actions.offlineNotice.result, "not_shown");
  assert.equal(readBarrier().noticeAt, null);
  assert.equal(readBarrier().noticeAttemptAt, null);
  observedAt += 4 * 60_000;
  await runSupervisorService(options);
  assert.equal(attempts, 1);
  observedAt += 60_000;
  await runSupervisorService(options);
  assert.equal(readRuntime(fixture).actions.offlineNotice.result, "shown");
  assert.equal(readBarrier().noticeAt, observedAt);
  assert.equal(readBarrier().noticeAttemptAt, null);
  observedAt += 5 * 60_000;
  await runSupervisorService(options);
  assert.equal(attempts, 2);
});

test("an explicitly disabled notice never starts its helper or debits its incident", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  const config = path.join(fixture.root, "interactive.json");
  fs.mkdirSync(path.dirname(barrier));
  const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
  fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: "development" } }));
  const environment = JSON.parse(fs.readFileSync(fixture.privateEnvPath, "utf8"));
  fs.writeFileSync(fixture.privateEnvPath, JSON.stringify({ ...environment, NAPCAT_OFFLINE_INTERACTIVE_CONFIG: config }));
  fs.writeFileSync(config, JSON.stringify({ offlineNoticeEnabled: false }));
  const before = Buffer.from(JSON.stringify({ ...loadOfflineRecoveryState(), needsManual: true }));
  fs.writeFileSync(barrier, before);
  let attempts = 0;
  const options = baseOptions(fixture, {
    checkNapCatStatus: async () => ({ reachable: true, runtimeStatus: { online: false, good: true } }),
    offlineRecoveryGuard: async () => { throw new Error("unexpected guard"); },
    showOfflineDesktopNotice: async () => { attempts += 1; return "notice_returned"; },
  });
  await runSupervisorService(options);
  await runSupervisorService({ ...options, now: () => new Date("2026-07-24T08:10:00.000Z") });
  assert.equal(attempts, 0);
  assert.deepEqual(fs.readFileSync(barrier), before);
  assert.equal(readRuntime(fixture).actions.offlineNotice, undefined);
});

for (const rearmed of [false, true]) {
  test(`a return to offline during ${rearmed ? "the twelve-hour embargo" : "the unrearmed interval"} requires manual login without stopping again`, async context => {
    const fixture = createFixture();
    context.after(fixture.cleanup);
    const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
    fs.mkdirSync(path.dirname(barrier));
    const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
    fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: "development" } }));
    let observedAt = Date.parse("2026-07-24T08:00:00Z");
    const attemptAt = observedAt - (rearmed ? 3_600_000 : 1000);
    fs.writeFileSync(barrier, JSON.stringify({ ...loadOfflineRecoveryState(), attemptAt, rearmed }));
    const process = { pid: 7003, name: "QQ.exe", creationDate: new Date(observedAt - 1000).toISOString(),
      commandLine: '"C:\\Fixture\\QQ.exe" --fixture-only' };
    let guardCalls = 0;
    let notices = 0;
    let cycles = 0;
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => new Date(observedAt),
      staleNapCatReachableOfflineMs: 100,
      checkNapCatStatus: async () => ({ reachable: true, runtimeStatus: { online: false, good: true } }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [process] }),
      offlineRecoveryGuard: async () => { guardCalls += 1; },
      showOfflineDesktopNotice: async () => { notices += 1; return "notice_returned"; },
      wait() {
        observedAt += 101;
        if (++cycles === 3) fs.writeFileSync(fixture.stopFilePath, "test ended");
      },
    }));
    const report = readRuntime(fixture);
    assert.equal(guardCalls, 0);
    assert.equal(notices, 1);
    assert.equal(report.login.blocked, true);
    assert.equal(report.autoOfflineRecovery.needsManual, true);
    assert.equal(report.autoOfflineRecovery.attemptAt, attemptAt);
    assert.equal(report.actions.staleNapCatRecovery.reachableOfflinePreserved, true);
  });
}

test("a confirmed reachable recovery clears the manual hold in the same scan", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  let observedAt = Date.parse("2026-07-24T08:00:00Z");
  const process = { pid: 7003, name: "QQ.exe", creationDate: new Date(observedAt - 1000).toISOString(),
    commandLine: '"C:\\Fixture\\QQ.exe" --fixture-only' };
  let cycles = 0;
  let notices = 0;
  await runSupervisorService(baseOptions(fixture, {
    once: false,
    now: () => new Date(observedAt),
    staleNapCatReachableOfflineMs: 100,
    checkNapCatStatus: async () => ({ reachable: true, runtimeStatus: { online: false, good: true } }),
    checkNapCatProcesses: async () => ({ known: true, present: true, processes: [process] }),
    checkNativeQuickLogin: async () => ({ fileSha256: "fixture" }),
    offlineRecoveryGuard: async () => ({ status: "recovered", changed: true, reason: "verified_online" }),
    showOfflineDesktopNotice: async () => { notices += 1; return "notice_returned"; },
    wait() {
      observedAt += 101;
      if (++cycles === 2) fs.writeFileSync(fixture.stopFilePath, "test ended");
    },
  }));
  const report = readRuntime(fixture);
  assert.equal(report.actions.staleNapCatRecovery.succeeded, true);
  assert.equal(report.login.blocked, false);
  assert.equal(report.autoOfflineRecovery.needsManual, false);
  assert.equal(report.autoOfflineRecovery.rearmed, false);
  assert.equal(notices, 0);
});

test("only an acknowledged stop with a manual result permits a disconnected notice", async context => {
  for (const stopped of [false, true]) {
    const fixture = createFixture();
    context.after(fixture.cleanup);
    const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
    fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: "development" } }));
    let observedAt = Date.parse("2026-07-24T08:00:00Z");
    const process = { pid: 7011, name: "QQ.exe", creationDate: new Date(observedAt - 1000).toISOString(),
      commandLine: '"C:\\Fixture\\QQ.exe" --fixture-only' };
    let cycles = 0;
    let notices = 0;
    const options = baseOptions(fixture, {
      once: false,
      now: () => new Date(observedAt),
      staleNapCatReachableOfflineMs: 100,
      checkNapCatStatus: async () => cycles < 2
        ? { reachable: true, runtimeStatus: { online: false, good: true } }
        : { known: true, reachable: false, online: false },
      checkNapCatProcesses: async () => ({ known: true, present: cycles < 2, processes: cycles < 2 ? [process] : [] }),
      checkNativeQuickLogin: async () => ({ fileSha256: "fixture" }),
      offlineRecoveryGuard: async () => stopped
        ? { status: "needs-manual", changed: true, reason: "manual_login_required" }
        : { status: "unknown", changed: null, reason: "stop_unverified" },
      showOfflineDesktopNotice: async () => {
        if (cycles < 2) return "notice_offline_unverified";
        const runtime = readRuntime(fixture);
        assert.ok(Number.isSafeInteger(runtime.autoOfflineRecovery.manualAfterVerifiedStopAt));
        assert.equal(runtime.login.blocked, true);
        notices += 1;
        return "notice_returned";
      },
      wait() {
        observedAt += cycles === 1 ? 5 * 60_000 : 101;
        if (++cycles === 3) fs.writeFileSync(fixture.stopFilePath, "test ended");
      },
    });
    await runSupervisorService(options);
    assert.equal(notices, stopped ? 1 : 0);
    assert.equal(Number.isSafeInteger(readRuntime(fixture).autoOfflineRecovery.manualAfterVerifiedStopAt), stopped);
  }
});

test("an unconfigured Windows recovery preserves legacy no-process login without dropping an unresolved guard hold", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
  const calls = [];
  const options = baseOptions(fixture, {
    useWindowsOfflineGuard: true,
    checkNapCatStatus: async () => ({ known: true, reachable: false }),
    checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }),
    quickLogin: async request => calls.push(request.noQr),
  });
  await runSupervisorService(options);
  assert.deepEqual(calls, [true]);
  fs.writeFileSync(barrier, JSON.stringify({ ...loadOfflineRecoveryState(), needsManual: true }));
  fs.writeFileSync(fixture.runtimeStatePath, "{}\n");
  await runSupervisorService({ ...options, now: () => new Date("2026-07-25T08:00:00.000Z") });
  assert.deepEqual(calls, [true]);
  assert.equal(readRuntime(fixture).actions.quickLogin.reason, "manual_login_required");
});

test("the real Windows helper rejects incomplete stdin without using account files", { skip: process.platform !== "win32" }, async () => {
  const scriptPath = path.resolve("ops", "invoke-napcat-offline-recovery.ps1");
  const result = await invokeOfflineRecoveryGuard({}, { scriptPath, timeoutMs: 15_000, env: { ...process.env, PSModulePath: "X:\\fixture" } });
  assert.deepEqual(result, { status: "deferred", changed: false, reason: "invalid_request", nativeQuickLoginVerified: false });
});

test("repeated offline guard startup timeouts back off 60s then 15m and reset once napcat is online", async context => {
  const fixture = createFixture();
  context.after(fixture.cleanup);
  let observedAt = Date.parse("2026-07-24T08:00:00.000Z");
  let onlineNow = false;
  let guardCalls = 0;
  const recorded = [];
  const advances = [
    30_000,
    29_000,
    1_000,
    60_000,
    13 * 60_000 + 59_000,
    1_000,
    10_000,
    10_000,
    59_000,
    1_000,
  ];
  let step = 0;
  await runSupervisorService(baseOptions(fixture, {
    once: false,
    loginCooldownMs: 1_000,
    now: () => new Date(observedAt),
    checkNapCatStatus: async () => onlineNow
      ? { known: true, reachable: true, online: true, accountMatches: true }
      : { known: true, reachable: false, online: false, accountMatches: false },
    checkNapCatProcesses: async () => ({ known: true, present: onlineNow, processes: onlineNow ? [{ pid: 7003, name: "NapCat.exe" }] : [] }),
    offlineRecoveryGuard: async () => {
      guardCalls += 1;
      if (guardCalls === 5) return { status: "started", changed: true, reason: "verified_online", nativeQuickLoginVerified: true };
      return { status: "deferred", changed: false, reason: "offline_guard_startup_timeout", nativeQuickLoginVerified: false };
    },
    wait: async () => {
      const runtime = readRuntime(fixture);
      recorded.push({
        step,
        online: onlineNow,
        guardCalls,
        reason: runtime.actions.quickLogin?.reason ?? null,
        succeeded: runtime.actions.quickLogin?.succeeded ?? null,
        blocked: runtime.login.blocked,
      });
      if (step >= advances.length) {
        fs.writeFileSync(fixture.stopFilePath, "test ended");
        return;
      }
      observedAt += advances[step];
      step += 1;
      onlineNow = step === 7;
    },
  }));
  assert.deepEqual(recorded, [
    { step: 0, online: false, guardCalls: 1, reason: "offline_guard_startup_timeout", succeeded: null, blocked: false },
    { step: 1, online: false, guardCalls: 1, reason: "offline_guard_startup_timeout", succeeded: null, blocked: false },
    { step: 2, online: false, guardCalls: 1, reason: "offline_guard_startup_timeout", succeeded: null, blocked: false },
    { step: 3, online: false, guardCalls: 2, reason: "offline_guard_startup_timeout_exhausted", succeeded: null, blocked: false },
    { step: 4, online: false, guardCalls: 2, reason: "offline_guard_startup_timeout_exhausted", succeeded: null, blocked: false },
    { step: 5, online: false, guardCalls: 2, reason: "offline_guard_startup_timeout_exhausted", succeeded: null, blocked: false },
    { step: 6, online: false, guardCalls: 3, reason: "offline_guard_startup_timeout_exhausted", succeeded: null, blocked: false },
    { step: 7, online: true, guardCalls: 3, reason: null, succeeded: null, blocked: false },
    { step: 8, online: false, guardCalls: 4, reason: "offline_guard_startup_timeout", succeeded: null, blocked: false },
    { step: 9, online: false, guardCalls: 4, reason: "offline_guard_startup_timeout", succeeded: null, blocked: false },
    { step: 10, online: false, guardCalls: 5, reason: null, succeeded: true, blocked: false },
  ]);
});

test("生产 CLI 解析约定参数，并保留可选脚本路径", () => {
  const fixture = createFixture();
  try {
    const parsed = parseArguments([
      "--private-env", fixture.privateEnvPath,
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--interval-ms", "30000",
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--data-root", fixture.root,
      "--broker-root", path.join(fixture.root, "broker"),
      "--broker-start-script", fixture.brokerStartScriptPath,
      "--login-script", fixture.loginScriptPath,
      "--napcat-root", fixture.napcatRoot,
      "--qq-exe-path", fixture.qqExePath,
      "--qq-user-data-dir", fixture.qqUserDataDir,
      "--stale-napcat-unknown-ms", "180000",
    ]);
    assert.equal(parsed.scanIntervalMs, 30000);
    assert.equal(parsed.brokerHealthUrl, "http://127.0.0.1:14588/health");
    assert.equal(parsed.privateEnvPath, path.resolve(fixture.privateEnvPath));
    assert.equal(parsed.loginScriptPath, path.resolve(fixture.loginScriptPath));
    assert.equal(parsed.napcatRoot, path.resolve(fixture.napcatRoot));
    assert.equal(parsed.qqExePath, path.resolve(fixture.qqExePath));
    assert.equal(parsed.rootDir, path.resolve(fixture.root));
    assert.equal(parsed.brokerRoot, path.resolve(fixture.root, "broker"));
    assert.equal(parsed.qqUserDataDir, path.resolve(fixture.qqUserDataDir));
    assert.equal(parsed.staleNapCatOfflineMs, 30 * 60_000);
    assert.equal(parsed.staleNapCatUnknownMs, 180_000);
    assert.throws(() => parseArguments(["--binding", fixture.bindingPath]), /缺少参数 --registry/);
    assert.throws(() => parseArguments([
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--interval-ms", "0",
    ]), /--interval-ms 必须是不小于 1 的整数/);
  } finally {
    fixture.cleanup();
  }
});

test("supervisor 默认离线宽限不会回退成几分钟内重登", () => {
  const fixture = createFixture();
  try {
    const parsed = parseArguments([
      "--private-env", fixture.privateEnvPath,
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--data-root", fixture.root,
      "--broker-root", path.join(fixture.root, "broker"),
      "--broker-start-script", fixture.brokerStartScriptPath,
      "--login-script", fixture.loginScriptPath,
      "--napcat-root", fixture.napcatRoot,
      "--qq-exe-path", fixture.qqExePath,
      "--qq-user-data-dir", fixture.qqUserDataDir,
    ]);
    assert.equal(parsed.staleNapCatOfflineMs, 30 * 60_000);
    assert.equal(parsed.staleNapCatUnknownMs, 10 * 60_000);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 状态归一化不会把明确失败洗成 ready", () => {
  assert.equal(normalizeNapCatStatus({
    known: true,
    reachable: true,
    online: true,
    accountMatches: true,
    ready: false,
    runtimeStatus: { online: true, good: true },
  }).ready, false);
  assert.equal(normalizeNapCatStatus({
    known: true,
    reachable: true,
    online: true,
    accountMatches: true,
    ready: true,
    runtimeStatus: { online: true, good: false },
  }).ready, false);
  assert.equal(normalizeNapCatStatus({
    known: true,
    reachable: true,
    online: true,
    accountMatches: true,
    ready: true,
    runtimeStatus: { online: true, good: true },
  }).ready, true);
});

test("quick-login 参数固定带 -NoQr、默认禁用密码回退、短 timeout 和 NapCat 根目录", () => {
  const fixture = createFixture();
  try {
    const argumentsList = buildQuickLoginArguments({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
      rootDir: fixture.root,
      brokerRoot: path.join(fixture.root, "broker"),
      qqUserDataDir: fixture.qqUserDataDir,
      timeoutMs: 35_000,
      codexHome: fixture.root,
    });
    assert.deepEqual(argumentsList.slice(0, 4), ["-NoQr", "-TimeoutSeconds", "35", "-NapCatRoot"]);
    assert.equal(argumentsList.includes("-NoPasswordFallback"), true);
    assert.equal(argumentsList.includes("-Qr"), false);
    const dataRootIndex = argumentsList.indexOf("-DataRoot");
    assert.equal(argumentsList[dataRootIndex + 1], path.resolve(fixture.root));
    const brokerRootIndex = argumentsList.indexOf("-BrokerRoot");
    assert.equal(argumentsList[brokerRootIndex + 1], path.resolve(fixture.root, "broker"));
    const qqPathIndex = argumentsList.indexOf("-QqExePath");
    assert.equal(argumentsList[qqPathIndex + 1], path.resolve(fixture.qqExePath));
    const qqDataIndex = argumentsList.indexOf("-QqUserDataDir");
    assert.equal(argumentsList[qqDataIndex + 1], path.resolve(fixture.qqUserDataDir));
    assert.equal(argumentsList.at(-1), path.resolve(fixture.root));
  } finally {
    fixture.cleanup();
  }
});

test("quick-login 给登录脚本保留清理隐藏进程的超时余量", async () => {
  const fixture = createFixture();
  const calls = [];
  try {
    await runQuickLogin({
      loginScriptPath: fixture.loginScriptPath,
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
      timeoutMs: 35_000,
      execFileImpl(executable, argumentsList, options, callback) {
        calls.push({ executable, argumentsList, options });
        callback(null, "{}\n", "");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeout, 50_000);
    assert.equal(calls[0].argumentsList.includes("-NoQr"), true);
    assert.equal(calls[0].argumentsList.includes("-NoPasswordFallback"), true);
    assert.equal(calls[0].argumentsList.includes("-NapCatRoot"), true);
    assert.equal(calls[0].argumentsList.includes(path.resolve(fixture.napcatRoot)), true);
    assert.equal(calls[0].argumentsList.includes("-QqExePath"), true);
    assert.equal(calls[0].argumentsList.includes(path.resolve(fixture.qqExePath)), true);
  } finally {
    fixture.cleanup();
  }
});

test("独立 QQ 路径会纳入运行完整性检查，旧配置仍保持兼容", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(fixture.napcatRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.napcatRoot, "launcher-user.bat"), "@echo off", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "napcat.mjs"), "", "utf8");
    assert.equal(checkNapCatRuntime({ napcatRoot: fixture.napcatRoot }).ready, true);

    const missingPinnedRuntime = checkNapCatRuntime({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
    });
    assert.equal(missingPinnedRuntime.ready, false);
    assert.equal(missingPinnedRuntime.missingFiles.includes(path.resolve(fixture.qqExePath)), true);

    fs.mkdirSync(path.dirname(fixture.qqExePath), { recursive: true });
    fs.writeFileSync(fixture.qqExePath, "", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "NapCatWinBootMain.exe"), "", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "NapCatWinBootHook.dll"), "", "utf8");
    fs.unlinkSync(path.join(fixture.napcatRoot, "launcher-user.bat"));
    assert.equal(checkNapCatRuntime({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
    }).ready, true);

    assert.equal(checkNapCatRuntime({ napcatRoot: fixture.napcatRoot }).ready, false);
  } finally {
    fixture.cleanup();
  }
});

test("进程识别不会把监督器自身、桌面 QQ 或任意 broker 路径误判为目标进程", () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat-Codex";
  const pinnedQqPath = "C:\\Users\\ExampleUser\\NapCat-QQ\\QQ.exe";
  const processes = [
    { ProcessId: 1, Name: "node.exe", CommandLine: `node C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\src\\supervisor-runner.mjs --login-script C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\ops\\start-napcat-login.ps1 --napcat-root "${napcatRoot}"` },
    { ProcessId: 2, Name: "QQ.exe", CommandLine: '"C:\\Program Files\\Tencent\\QQNT\\QQ.exe"' },
    { ProcessId: 3, Name: "NapCatWinBootMain.exe", CommandLine: `"${napcatRoot}\\NapCatWinBootMain.exe"` },
    { ProcessId: 4, Name: "node.exe", CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\broker.mjs' },
    { ProcessId: 5, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe" --type=crashpad-handler --user-data-dir=C:\\Users\\ExampleUser\\AppData\\Roaming\\Codex' },
    { ProcessId: 6, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe"' },
    { ProcessId: 7, Name: "codex.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\resources\\codex.exe" app-server' },
    { ProcessId: 8, Name: "NapCatWinBootMain.exe", CommandLine: '"C:\\Users\\Other\\NapCatWinBootMain.exe"' },
    { ProcessId: 9, Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${napcatRoot}\\index.js"` },
    { ProcessId: 10, Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${napcatRoot}\\napcat\\napcat.mjs" 10001` },
    { ProcessId: 11, Name: "QQ.exe", CommandLine: `"${pinnedQqPath}" --no-sandbox` },
    { ProcessId: 12, Name: "QQ.exe", CommandLine: `"${pinnedQqPath}"` },
    { ProcessId: 13, Name: "NapCatWinBootMain.exe", CommandLine: '"C:\\Users\\ExampleUser\\NapCat-Codex-Other\\NapCatWinBootMain.exe"' },
    { ProcessId: 14, Name: "node.exe", CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Other\\.codex\\mcp-http-broker\\broker.mjs' },
    { ProcessId: 15, Name: "powershell.exe", CommandLine: `powershell.exe -NoProfile -File C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\ops\\start-napcat-login.ps1 -NapCatRoot "${napcatRoot}"` },
    { ProcessId: 16, Name: "powershell.exe", CommandLine: `powershell -NoProfile -Command "node supervisor-runner.mjs --login-script C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\ops\\start-napcat-login.ps1 --napcat-root '${napcatRoot}'"` },
  ];
  assert.deepEqual(findNapCatProcesses(processes, napcatRoot, pinnedQqPath).map((item) => item.ProcessId), [3, 9, 10, 15]);
  assert.deepEqual(findBrokerProcesses(processes, "C:\\Users\\ExampleUser\\.codex\\mcp-http-broker").map((item) => item.ProcessId), [4]);
  assert.deepEqual(findCodexProcesses(processes).map((item) => item.ProcessId), [6, 7]);
});

test("固定 QQ 路径本身不会把 QQNT 和 QQEx 认作 NapCat", () => {
  const qqntPath = "C:\\Users\\ExampleUser\\NapCat-QQ\\QQNT.exe";
  const qqexPath = "C:\\Users\\ExampleUser\\NapCat-QQ\\QQEX.exe";
  assert.deepEqual(findNapCatProcesses([
    { ProcessId: 21, Name: "QQNT.exe", CommandLine: `"${qqntPath}" --no-sandbox` },
    { ProcessId: 22, Name: "QQ.exe", CommandLine: '"C:\\Program Files\\Tencent\\QQNT\\QQ.exe"' },
  ], null, qqntPath).map((item) => item.ProcessId), []);
  assert.deepEqual(findNapCatProcesses([
    { ProcessId: 23, Name: "QQEx.exe", CommandLine: `"${qqexPath}" --profile C:\\Users\\ExampleUser\\NapCatProfile` },
    { ProcessId: 24, Name: "QQ.exe", CommandLine: '"C:\\Program Files\\Tencent\\QQNT\\QQ.exe"' },
  ], null, qqexPath).map((item) => item.ProcessId), []);
});

test("单次缺失 online 字段只开始未知状态宽限期，不会立即停止进程", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  const processes = [{ pid: 6001, parentPid: 5000, name: "node.exe" }];
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        offlineProcessFingerprint: processSnapshotFingerprint(processes),
      },
    });
    assert.equal(normalizeNapCatStatus({ reachable: true, accountMatches: true }).known, false);
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ reachable: true, accountMatches: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    assert.equal(stopCount, 0);
    const runtime = readRuntime(fixture);
    assert.equal(runtime.login.unknownProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.actions.staleNapCatRecovery.trigger, "status_unknown");
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "grace_period");
  } finally {
    fixture.cleanup();
  }
});

test("真实 status 形状里 reachable=true 且 runtimeStatus.online=false 不会被归类为未知", () => {
  const normalized = normalizeNapCatStatus({
    reachable: true,
    runtimeStatus: { online: false, good: false },
    accountMatches: false,
  });
  assert.equal(normalized.known, true);
  assert.equal(normalized.reachable, true);
  assert.equal(normalized.online, false);
  assert.equal(normalized.ready, false);
  assert.equal(normalized.accountMatches, false);
});

test("quick-login 可显式允许密码回退", () => {
  const fixture = createFixture();
  try {
    const argumentsList = buildQuickLoginArguments({
      napcatRoot: fixture.napcatRoot,
      rootDir: fixture.root,
      timeoutMs: 35_000,
      noPasswordFallback: false,
    });
    assert.equal(argumentsList.includes("-NoPasswordFallback"), false);
  } finally {
    fixture.cleanup();
  }
});

test("监督器与 task router 使用彼此独立的 runtime、stop 和 lock 文件", () => {
  const fixture = createFixture();
  try {
    const dependencies = createSupervisorDependencies({
      ...fixture,
      notifier: {},
      registry: {},
      routerController: {},
    });
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_RUNTIME_PATH, path.join(fixture.root, "state", "task-router-runtime.json"));
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_STOP_PATH, path.join(fixture.root, "state", "task-router.stop"));
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_LOCK_PATH, path.join(fixture.root, "state", "task-router.lock"));
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_RUNTIME_PATH, fixture.runtimeStatePath);
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_STOP_PATH, fixture.stopFilePath);
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_LOCK_PATH, fixture.lockPath);
  } finally {
    fixture.cleanup();
  }
});

test("监督器从 NAPCAT_MCP_ROOT 启动 task router，但仍把状态保存在 DataRoot", () => {
  const fixture = createFixture();
  const codeRoot = path.join(fixture.root, "services", "napcat-bridge", "current");
  const brokerRoot = path.join(fixture.root, "broker-root");
  let controllerOptions = null;
  try {
    const dependencies = createSupervisorDependencies({
      ...fixture,
      privateEnvironment: {
        CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
        NAPCAT_MCP_ROOT: codeRoot,
        NAPCAT_HTTP_URL: "http://127.0.0.1:3010",
        NAPCAT_ACCESS_TOKEN: "test-token",
      },
      notifier: {},
      registry: {},
      createTaskRouterController(options) {
        controllerOptions = options;
        return {};
      },
    });
    assert.equal(dependencies.codeRoot, path.resolve(codeRoot));
    assert.equal(dependencies.brokerRoot, path.resolve(brokerRoot));
    assert.notEqual(dependencies.brokerRoot, dependencies.rootDir);
    assert.equal(controllerOptions.rootDir, path.resolve(fixture.root));
    assert.equal(controllerOptions.runnerPath, path.join(path.resolve(codeRoot), "src", "task-router-runner.mjs"));
    assert.equal(controllerOptions.env.NAPCAT_TASK_REGISTRY_PATH, path.resolve(fixture.registryPath));
  } finally {
    fixture.cleanup();
  }
});

test("满足 broker、NapCat 固定账号、Codex 和 open task 后才启动 task router", async () => {
  const fixture = createFixture();
  let startCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      startTaskRouter() {
        startCount += 1;
        return { started: true, pid: 5001 };
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "once_completed");
    assert.equal(startCount, 1);
    assert.equal(runtime.checks.gate, true);
    assert.equal(runtime.openTaskCount, 1);
    assert.equal(runtime.actions.taskRouter.succeeded, true);
    assert.equal(fs.existsSync(fixture.lockPath), false);
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.runtimeStatePath)).filter((name) => name.includes(".tmp-")), []);
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"type":"supervisor_check"/);
  } finally {
    fixture.cleanup();
  }
});

test("supervisor 主日志会轮转，并写出轻量诊断日志", async () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.logPath), { recursive: true });
    fs.writeFileSync(fixture.logPath, `${"x".repeat(5 * 1024 * 1024)}\n`, "utf8");
    await runSupervisorService(baseOptions(fixture));
    const diagnosticPath = path.join(path.dirname(fixture.logPath), "supervisor-diagnostics.jsonl");
    const currentLog = fs.readFileSync(fixture.logPath, "utf8");
    const diagnosticLog = fs.readFileSync(diagnosticPath, "utf8");
    assert.equal(fs.existsSync(`${fixture.logPath}.1`), true);
    assert.ok(fs.statSync(fixture.logPath).size < 4 * 1024 * 1024);
    assert.match(currentLog, /"type":"supervisor_check"/);
    assert.match(diagnosticLog, /"type":"supervisor_diagnostic"/);
    assert.match(diagnosticLog, /"online":true/);
    assert.match(diagnosticLog, /"ready":true/);
    assert.doesNotMatch(diagnosticLog, /test-token/);
  } finally {
    fixture.cleanup();
  }
});

test("任一前置条件不满足时不启动 task router，也不恢复 heartbeat", async () => {
  const fixture = createFixture();
  let startCount = 0;
  let heartbeatCalls = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkBrokerHealth: async () => ({ known: true, healthy: false, reachable: true }),
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
      checkCodexProcesses: async () => ({ known: true, present: true }),
      getOpenTaskCount: async () => 1,
      startTaskRouter() {
        startCount += 1;
        return { started: true };
      },
      resumeHeartbeat() {
        heartbeatCalls += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(startCount, 0);
    assert.equal(heartbeatCalls, 0);
    assert.equal(runtime.checks.gate, false);
    assert.equal(runtime.actions.taskRouter.reason, "gate_closed");
  } finally {
    fixture.cleanup();
  }
});

test("broker 或 NapCat 进程缺失时即使接口健康也关闭 router 门槛", async () => {
  for (const missingProcess of ["broker", "napcat"]) {
    const fixture = createFixture();
    let startCount = 0;
    try {
      await runSupervisorService(baseOptions(fixture, {
        ...(missingProcess === "broker"
          ? { checkBrokerProcesses: async () => ({ known: true, present: false, processes: [] }) }
          : { checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }) }),
        startTaskRouter() {
          startCount += 1;
          return { started: true };
        },
      }));
      const runtime = readRuntime(fixture);
      assert.equal(startCount, 0);
      assert.equal(runtime.checks.gate, false);
      assert.equal(runtime.actions.taskRouter.reason, "gate_closed");
    } finally {
      fixture.cleanup();
    }
  }
});

test("broker health 离线且没有 broker 进程时才调用隐藏启动回调", async () => {
  const fixture = createFixture();
  let startCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkBrokerHealth: async () => ({ known: true, healthy: false, reachable: true }),
      checkBrokerProcesses: async () => ({ known: true, present: false }),
      startBroker(input) {
        startCount += 1;
        assert.equal(input.hidden, true);
        return { started: true };
      },
    }));
    assert.equal(result.state, "stopped");
    assert.equal(startCount, 1);
    assert.equal(readRuntime(fixture).actions.brokerStart.succeeded, true);
  } finally {
    fixture.cleanup();
  }
});

test("OneBot 离线但已有 NapCat 进程时不启动第二份，且无 open task 不启动 router", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  let routerCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 6001, name: "NapCat.exe" }] }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
      startTaskRouter() {
        routerCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(loginCount, 0);
    assert.equal(routerCount, 0);
    assert.equal(runtime.actions.quickLogin.reason, "napcat_process_present");
    assert.equal(runtime.checks.gate, false);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 离线且无进程时调用无二维码登录，并在冷却内抑制重复调用", async () => {
  const fixture = createFixture();
  const attempts = [];
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => currentTime,
      loginCooldownMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin(input) {
        attempts.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 1_000);
        if (waitCount >= 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "stop_file");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].noQr, true);
    assert.equal(attempts[0].timeoutMs, 30_000);
    assert.equal(waitCount, 3);
    assert.equal(readRuntime(fixture).login.lastResult, "started");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 核心文件缺失时不把运行损坏误判为快速登录授权过期", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  try {
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: false, online: false, accountMatches: false }),
      checkNapCatRuntime: async () => ({
        known: true,
        ready: false,
        napcatRoot: fixture.napcatRoot,
        requiredFiles: [path.join(fixture.napcatRoot, "launcher-user.bat"), path.join(fixture.napcatRoot, "napcat.mjs")],
        missingFiles: [path.join(fixture.napcatRoot, "napcat.mjs")],
        error: {
          code: "NAPCAT_RUNTIME_INCOMPLETE",
          message: "NapCat 运行文件缺失",
          outcomeUnknown: false,
        },
      }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(loginCount, 0);
    assert.equal(runtime.actions.quickLogin.reason, "runtime_incomplete");
    assert.equal(runtime.actions.quickLogin.error.code, "NAPCAT_RUNTIME_INCOMPLETE");
    assert.equal(runtime.checks.napcatRuntime.ready, false);
    assert.deepEqual(runtime.checks.napcatRuntime.missingFiles, [path.join(fixture.napcatRoot, "napcat.mjs")]);
    assert.equal(runtime.checks.gate, false);
  } finally {
    fixture.cleanup();
  }
});

test("OneBot 端口不可达且没有 NapCat 进程时仍尝试快速登录", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  try {
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3010"); },
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(loginCount, 1);
    assert.equal(runtime.actions.quickLogin.succeeded, true);
    assert.equal(runtime.checks.napcat.known, false);
  } finally {
    fixture.cleanup();
  }
});

test("runtime 中的 quick-login 冷却会跨监督器重启保留", async () => {
  const fixture = createFixture();
  const attempts = [];
  try {
    const common = {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      loginCooldownMs: 60_000,
      quickLogin(input) {
        attempts.push(input);
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:00:01.000Z"),
    }));
    assert.equal(attempts.length, 1);
    assert.equal(readRuntime(fixture).actions.quickLogin.reason, "cooldown");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 恢复在线后会清除跨重启保留的离线进程计时", async () => {
  const fixture = createFixture();
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        staleRecoveryLastAttemptAt: "2026-07-24T07:05:00.000Z",
        staleRecoveryNextAllowedAt: "2026-07-24T07:10:00.000Z",
        staleRecoveryCount: 2,
        staleRecoveryLastResult: "stopped",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7003, name: "node.exe" }] }),
    }));
    const runtime = readRuntime(fixture);
    assert.equal(runtime.login.offlineProcessSince, null);
    assert.equal(runtime.login.staleRecoveryCount, 2);
    assert.equal(runtime.actions.staleNapCatRecovery, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("跨重启发现新的可达 NapCat 离线进程时重新记录身份但不停止", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  const currentProcesses = [{ pid: 7101, parentPid: 5000, name: "node.exe" }];
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        offlineProcessFingerprint: "old-process-fingerprint",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: currentProcesses }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCount, 0);
    assert.equal(runtime.login.offlineProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.login.offlineProcessFingerprint, processSnapshotFingerprint(currentProcesses));
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "reachable_offline_preserved");
    assert.equal(runtime.actions.staleNapCatRecovery.reachableOfflinePreserved, true);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat HTTP 不可达且连续离线超过宽限期时只停止匹配进程树并立即无二维码恢复", async () => {
  const fixture = createFixture();
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  const stopCalls = [];
  const loginCalls = [];
  try {
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      useWindowsOfflineGuard: true,
      now: () => currentTime,
      scanIntervalMs: 60_000,
      staleNapCatOfflineMs: 120_000,
      staleNapCatRecoveryCooldownMs: 300_000,
      checkNapCatStatus: async () => ({ known: true, reachable: false, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({
        known: true,
        present: true,
        processes: [
          { pid: 6001, parentPid: 5000, name: "cmd.exe" },
          { pid: 6002, parentPid: 6001, name: "node.exe" },
        ],
      }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(input) {
        stopCalls.push(input);
        return { stopped: true, rootProcessIds: [6001] };
      },
      quickLogin(input) {
        loginCalls.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 60_000);
        if (waitCount >= 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 1);
    assert.deepEqual(stopCalls[0].processes.map((item) => item.pid), [6001, 6002]);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].noQr, true);
    assert.equal(runtime.login.staleRecoveryCount, 1);
    assert.equal(runtime.login.offlineProcessSince, null);
    assert.equal(runtime.actions.staleNapCatRecovery.succeeded, true);
    assert.equal(runtime.actions.quickLogin.succeeded, true);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat HTTP 可达但 online=false 时保留现有进程，不把状态抖动升级成重登", async () => {
  const fixture = createFixture();
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  const stopCalls = [];
  const loginCalls = [];
  const processes = [
    { pid: 6101, parentPid: 5100, name: "cmd.exe" },
    { pid: 6102, parentPid: 6101, name: "node.exe" },
  ];
  try {
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      useWindowsOfflineGuard: true,
      now: () => currentTime,
      scanIntervalMs: 60_000,
      staleNapCatOfflineMs: 60_000,
      staleNapCatRecoveryCooldownMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(input) {
        stopCalls.push(input);
        return { stopped: true, rootProcessIds: [6101] };
      },
      quickLogin(input) {
        loginCalls.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 60_000);
        if (waitCount >= 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 0);
    assert.equal(loginCalls.length, 0);
    assert.equal(runtime.actions.staleNapCatRecovery.attempted, false);
    assert.equal(runtime.actions.staleNapCatRecovery.trigger, "reachable_offline");
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "reachable_offline_guard_not_configured");
    assert.equal(runtime.actions.staleNapCatRecovery.reachableOfflinePreserved, true);
    assert.equal(runtime.actions.quickLogin.reason, "napcat_process_present");
    assert.equal(runtime.login.offlineProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.login.staleRecoveryCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("人工登录阻断时不会停止现有 NapCat 进程", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        blocked: true,
        blockedAt: "2026-07-24T07:00:00.000Z",
        blockedReason: { code: "NAPCAT_MANUAL_LOGIN_REQUIRED", message: "需要人工登录" },
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 6001, parentPid: 5000, name: "cmd.exe" }] }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    assert.equal(stopCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 状态持续未知超过宽限期时停止同一进程树并立即无二维码恢复", async () => {
  const fixture = createFixture();
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  const processes = [
    { pid: 6301, parentPid: 5300, name: "cmd.exe" },
    { pid: 6302, parentPid: 6301, name: "node.exe" },
  ];
  const stopCalls = [];
  const loginCalls = [];
  try {
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => currentTime,
      scanIntervalMs: 60_000,
      staleNapCatUnknownMs: 180_000,
      staleNapCatRecoveryCooldownMs: 300_000,
      checkNapCatStatus: async () => ({
        known: false,
        reachable: false,
        online: false,
        accountMatches: false,
        error: { code: "ONEBOT_TIMEOUT", message: "timeout" },
      }),
      checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(input) {
        stopCalls.push(input);
        return { stopped: true, rootProcessIds: [6301] };
      },
      quickLogin(input) {
        loginCalls.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 60_000);
        if (waitCount >= 4) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 1);
    assert.deepEqual(stopCalls[0].processes.map((item) => item.pid), [6301, 6302]);
    assert.equal(stopCalls[0].qqExePath, fixture.qqExePath);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].noQr, true);
    assert.equal(runtime.actions.staleNapCatRecovery.succeeded, true);
    assert.equal(runtime.actions.staleNapCatRecovery.trigger, "status_unknown");
    assert.equal(runtime.login.unknownProcessSince, null);
  } finally {
    fixture.cleanup();
  }
});

test("未知状态期间 NapCat 进程身份变化会重新开始宽限期", async () => {
  const fixture = createFixture();
  const currentProcesses = [{ pid: 6401, parentPid: 5400, name: "node.exe" }];
  let stopCount = 0;
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        unknownProcessSince: "2026-07-24T07:00:00.000Z",
        unknownProcessFingerprint: "old-process-fingerprint",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatUnknownMs: 60_000,
      checkNapCatStatus: async () => ({
        known: false,
        reachable: false,
        online: false,
        accountMatches: false,
        error: { code: "ONEBOT_TIMEOUT", message: "timeout" },
      }),
      checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: currentProcesses }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCount, 0);
    assert.equal(runtime.login.unknownProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.login.unknownProcessFingerprint, processSnapshotFingerprint(currentProcesses));
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "grace_period");
  } finally {
    fixture.cleanup();
  }
});

test("停止调用逐个覆盖已确认进程，不递归终止未核验的子进程", async () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat";
  const processes = [
    { pid: 6101, parentPid: 5000, name: "cmd.exe", commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"` },
    { pid: 6102, parentPid: 6101, name: "node.exe", commandLine: `node "${napcatRoot}\\index.js"` },
    { pid: 6201, parentPid: 5001, name: "cmd.exe", commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"` },
  ];
  assert.deepEqual(processTreeRootIds(processes), [6101, 6201]);
  const calls = [];
  await stopWindowsProcessTrees(processes, {
    currentPid: 9999,
    napcatRoot,
    listProcesses: async () => processes,
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, JSON.stringify({ stopped: true, rootProcessIds: [6101, 6102, 6201] }), "");
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /Stop-NapCatVerifiedProcesses/);
  assert.match(calls[0].args.at(-1), /"ProcessId":6101/);
  assert.match(calls[0].args.at(-1), /"ProcessId":6102/);
  assert.match(calls[0].args.at(-1), /"ProcessId":6201/);
  assert.doesNotMatch(calls[0].args.at(-1), /taskkill/);
});

test("停止前出现新的 owned 进程时保留全部进程等待重新核对", async () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat";
  const snapshot = [{ pid: 6101, parentPid: 5000, name: "cmd.exe", commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"` }];
  let calls = 0;
  await assert.rejects(stopWindowsProcessTrees(snapshot, {
    currentPid: 9999,
    napcatRoot,
    listProcesses: async () => [...snapshot, { pid: 6102, parentPid: 6101, name: "node.exe", commandLine: `node "${napcatRoot}\\index.js"` }],
    execFileImpl() { calls += 1; },
  }), (error) => error.code === "NAPCAT_PROCESS_IDENTITY_CHANGED");
  assert.equal(calls, 0);
});

test("停止前 PID 身份改变时拒绝 taskkill", async () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat";
  const snapshot = [{
    pid: 6101,
    parentPid: 5000,
    name: "cmd.exe",
    commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"`,
  }];
  let taskkillCount = 0;
  await assert.rejects(
    stopWindowsProcessTrees(snapshot, {
      currentPid: 9999,
      napcatRoot,
      listProcesses: async () => [{
        pid: 6101,
        parentPid: 5000,
        name: "codex.exe",
        commandLine: "codex.exe app-server",
      }],
      execFileImpl(file, args, options, callback) {
        taskkillCount += 1;
        callback(null, "SUCCESS", "");
      },
    }),
    (error) => error.code === "NAPCAT_PROCESS_IDENTITY_CHANGED",
  );
  assert.equal(taskkillCount, 0);
});

test("快速登录明确要求人工扫码后持续停止自动重试，直到真实在线后解除", async () => {
  const fixture = createFixture();
  let attempts = 0;
  const offline = async () => ({ known: true, reachable: true, online: false, accountMatches: false });
  const noProcess = async () => ({ known: true, present: false });
  try {
    const common = {
      checkNapCatStatus: offline,
      checkNapCatProcesses: noProcess,
      getOpenTaskCount: async () => 0,
      quickLogin() {
        attempts += 1;
        if (attempts >= 2) return { state: "started" };
        const error = new Error("[NAPCAT_MANUAL_LOGIN_REQUIRED] 快速登录记录已不可用");
        error.code = "NAPCAT_MANUAL_LOGIN_REQUIRED";
        throw error;
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    let runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.blockedReason.code, "NAPCAT_MANUAL_LOGIN_REQUIRED");

    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:05:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");
    assert.equal(runtime.login.blocked, true);

    await runSupervisorService(baseOptions(fixture, {
      ...common,
      manualLoginBlockRecheckMs: 1_000,
      now: () => new Date("2026-07-24T08:05:02.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");
    assert.equal(runtime.actions.quickLogin.autoRecheck, false);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.manualBlockRecheckCount, 0);

    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true, ready: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true }),
      getOpenTaskCount: async () => 0,
      now: () => new Date("2026-07-24T08:06:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(runtime.login.blocked, false);
    assert.equal(runtime.login.blockedAt, null);
    assert.equal(runtime.login.blockedReason, null);
  } finally {
    fixture.cleanup();
  }
});

test("人工登录阻断后即使残留离线进程陈旧也不自动清理重登", async () => {
  const fixture = createFixture();
  const processes = [
    { pid: 6801, parentPid: 5800, name: "cmd.exe", commandLine: `cmd /c "${fixture.napcatRoot}\\launcher-user.bat"` },
    { pid: 6802, parentPid: 6801, name: "node.exe", commandLine: `node "${fixture.napcatRoot}\\napcat.mjs"` },
  ];
  const stopCalls = [];
  let loginAttempts = 0;
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        blocked: true,
        blockedAt: "2026-07-24T07:00:00.000Z",
        blockedReason: { code: "NAPCAT_MANUAL_LOGIN_REQUIRED" },
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        offlineProcessFingerprint: processSnapshotFingerprint(processes),
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      staleNapCatRecoveryCooldownMs: 300_000,
      manualLoginBlockRecheckMs: 1_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(args) {
        stopCalls.push(args);
        return { rootProcessIds: [6801] };
      },
      quickLogin(args) {
        loginAttempts += 1;
        assert.equal(args.noQr, true);
        return { state: "started" };
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 0);
    assert.equal(loginAttempts, 0);
    assert.equal(runtime.actions.staleNapCatRecovery.attempted, false);
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "manual_login_required");
    assert.equal(runtime.actions.quickLogin.attempted, false);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");
    assert.equal(runtime.actions.quickLogin.autoRecheck, false);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.manualBlockRecheckCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("快速登录输出短信验证链接时即使没有专用错误码也会停止重试", async () => {
  const fixture = createFixture();
  let attempts = 0;
  const offline = async () => ({ known: true, reachable: true, online: false, accountMatches: false });
  const noProcess = async () => ({ known: true, present: false });
  try {
    const common = {
      checkNapCatStatus: offline,
      checkNapCatProcesses: noProcess,
      getOpenTaskCount: async () => 0,
      quickLogin() {
        attempts += 1;
        const error = new Error("Command failed: powershell start-napcat-login.ps1");
        error.code = 1;
        error.stdout = "快速登录错误： 登录态已失效，请重新登录。\n需要验证码, proofWaterUrl: https://ti.qq.com/safe/tools/captcha/sms-verify-login";
        throw error;
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    let runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.blockedReason.code, "NAPCAT_MANUAL_LOGIN_REQUIRED");

    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:05:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");
  } finally {
    fixture.cleanup();
  }
});

test("快速登录凭据无法解密时进入人工阻断且不循环重试", async () => {
  const fixture = createFixture();
  let attempts = 0;
  const offline = async () => ({ known: true, reachable: true, online: false, accountMatches: false });
  const noProcess = async () => ({ known: true, present: false });
  try {
    const common = {
      checkNapCatStatus: offline,
      checkNapCatProcesses: noProcess,
      getOpenTaskCount: async () => 0,
      quickLogin() {
        attempts += 1;
        const error = new Error("[NAPCAT_MANUAL_LOGIN_REQUIRED] 加密密码回退凭据不可用：NapCat quick-login credential cannot be decrypted for the bound account and current Windows user");
        error.code = 1;
        throw error;
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    let runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.blockedReason.code, "NAPCAT_MANUAL_LOGIN_REQUIRED");

    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:05:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");
  } finally {
    fixture.cleanup();
  }
});

test("快速登录返回人工登录状态对象时不能被记为成功", async () => {
  const fixture = createFixture();
  let attempts = 0;
  try {
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin(args) {
        attempts += 1;
        assert.equal(args.rootDir, path.resolve(fixture.root));
        assert.equal(args.qqUserDataDir, path.resolve(fixture.qqUserDataDir));
        return {
          state: "manual_login_required",
          reason: "快速登录记录已不可用，自动路径已禁用密码回退",
          qrCodePath: path.join(fixture.napcatRoot, "napcat", "cache", "qrcode.png"),
        };
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.actions.quickLogin.succeeded, false);
    assert.equal(runtime.login.lastResult.code, "NAPCAT_MANUAL_LOGIN_REQUIRED");
  } finally {
    fixture.cleanup();
  }
});

test("陈旧锁可恢复，活锁会返回 duplicate，runtime JSON 始终原子替换", async () => {
  const staleFixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(staleFixture.lockPath), { recursive: true });
    fs.writeFileSync(staleFixture.lockPath, JSON.stringify({ pid: 9001, startedAt: "old" }), "utf8");
    const recovered = await runSupervisorService(baseOptions(staleFixture, {
      isProcessAlive: () => false,
      getOpenTaskCount: async () => 0,
    }));
    assert.equal(recovered.state, "stopped");
    assert.equal(fs.existsSync(staleFixture.lockPath), false);
    assert.equal(readRuntime(staleFixture).schemaVersion, 1);
    atomicWriteJson(staleFixture.runtimeStatePath, { marker: "replaced" });
    assert.deepEqual(JSON.parse(fs.readFileSync(staleFixture.runtimeStatePath, "utf8")), { marker: "replaced" });
    assert.deepEqual(fs.readdirSync(path.dirname(staleFixture.runtimeStatePath)).filter((name) => name.includes(".tmp-")), []);
  } finally {
    staleFixture.cleanup();
  }

  const liveFixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(liveFixture.lockPath), { recursive: true });
    fs.writeFileSync(liveFixture.lockPath, JSON.stringify({ pid: 9002, startedAt: "2026-07-24T08:00:00.000Z" }), "utf8");
    const duplicate = await runSupervisorService(baseOptions(liveFixture, {
      isProcessAlive: (pid) => pid === 9002,
    }));
    assert.equal(duplicate.state, "duplicate");
    assert.equal(fs.existsSync(liveFixture.runtimeStatePath), false);
  } finally {
    liveFixture.cleanup();
  }
});

test("PowerShell 调用默认隐藏，登录脚本通过 execFile 时仍保留 -NoQr", async () => {
  const calls = [];
  const result = await invokePowerShellScript("C:\\ops\\login.ps1", ["-NoQr"], {
    execFileImpl(executable, argumentsList, options, callback) {
      calls.push({ executable, argumentsList, options });
      callback(null, "ok\n", "");
    },
  });
  assert.equal(result.stdout, "ok\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].argumentsList.includes("-NoQr"), true);
  assert.equal(calls[0].argumentsList.includes("-WindowStyle"), true);
  assert.equal(calls[0].argumentsList[calls[0].argumentsList.indexOf("-WindowStyle") + 1], "Hidden");
});

test("监督器的 Windows PowerShell 子进程隔离 PS7 模块路径并保留中文", { skip: process.platform !== "win32" }, async () => {
  const inherited = { ...process.env, PSModulePath: "C:\\Fixture\\PowerShell7\\Modules" };
  delete inherited.NAPCAT_POWERSHELL_PATH;
  delete inherited.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH;
  const before = { ...inherited };
  const command = "$row = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop; [pscustomobject]@{name=$row.Name;text='中文 含空格';version=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress";
  const result = await invokePowerShellCommand(command, { env: inherited, timeoutMs: 10_000 });
  assert.equal(result.value[0].text, "中文 含空格");
  assert.match(result.value[0].version, /^5\.1\./);
  assert.equal(result.value[0].name.toLowerCase(), "powershell.exe");
  assert.deepEqual(inherited, before);
});

test("监督器配置官方 PowerShell 7 路径时子进程真实运行于 PS7 RemoteSigned 且零 Bypass", {
  skip: process.platform !== "win32" || !(process.env.NAPCAT_POWERSHELL_PATH && /pwsh\.exe$/i.test(process.env.NAPCAT_POWERSHELL_PATH)),
}, async () => {
  const pwshPath = process.env.NAPCAT_POWERSHELL_PATH;
  const inherited = { ...process.env, PSModulePath: "C:\\Fixture\\Dirty\\Modules", PSExecutionPolicyPreference: "Bypass" };
  const command = "$row = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop; [pscustomobject]@{name=$row.Name;version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;effective=(Get-ExecutionPolicy).ToString();process=(Get-ExecutionPolicy -Scope Process).ToString()} | ConvertTo-Json -Compress";
  const result = await invokePowerShellCommand(command, { env: inherited, powershellPath: pwshPath, timeoutMs: 15_000 });
  assert.equal(result.value[0].name.toLowerCase(), "pwsh.exe");
  assert.equal(result.value[0].edition, "Core");
  assert.match(result.value[0].version, /^7\./);
  assert.equal(result.value[0].effective, "RemoteSigned");
  assert.equal(result.value[0].process, "Undefined");
});

test("invokeOfflineRecoveryGuard 配置 pwsh.exe 时零 Bypass 且清理 PSModulePath 与 PSExecutionPolicyPreference", async () => {
  const pwshPath = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\\pwsh.exe";
  const scriptPath = "C:\\ops\\invoke-napcat-offline-recovery.ps1";
  const inherited = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    psmodulepath: "C:\\Legacy\\Modules",
    PSExecutionPolicyPreference: "Bypass",
    psexecutionpolicypreference: "Unrestricted",
    NAPCAT_TEST_KEEP: "preserved",
  };
  const before = { ...inherited };
  const calls = [];
  const result = await invokeOfflineRecoveryGuard({ action: "quick-login" }, {
    scriptPath,
    timeoutMs: 15_000,
    powershellPath: pwshPath,
    env: inherited,
    exec(executable, args, options, callback) {
      let received = "";
      calls.push({ executable, args, options });
      return {
        stdin: {
          on() {},
          end(payload) {
            received = payload;
            callback(null, JSON.stringify({
              status: "deferred",
              changed: false,
              reason: "invalid_request",
              nativeQuickLoginVerified: false,
            }));
          },
        },
        get received() { return received; },
      };
    },
  });
  assert.deepEqual(result, {
    status: "deferred",
    changed: false,
    reason: "invalid_request",
    nativeQuickLoginVerified: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, pwshPath);
  assert.deepEqual(calls[0].args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath]);
  assert.equal(calls[0].args.some((arg) => /executionpolicy|bypass/i.test(arg)), false);
  const envKeysLower = Object.keys(calls[0].options.env).map((key) => key.toLowerCase());
  assert.equal(envKeysLower.includes("psmodulepath"), false);
  assert.equal(envKeysLower.includes("psexecutionpolicypreference"), false);
  assert.equal(calls[0].options.env.NAPCAT_TEST_KEEP, "preserved");
  assert.deepEqual(inherited, before);

  await assert.rejects(
    invokeOfflineRecoveryGuard({}, { scriptPath, timeoutMs: 15_000, powershellPath: "pwsh.exe" }),
    { code: "NAPCAT_OFFLINE_GUARD_CONFIGURATION_INVALID" },
  );
  await assert.rejects(
    invokeOfflineRecoveryGuard({}, { scriptPath, timeoutMs: 15_000, powershellPath: "C:\\Windows\\System32\\cmd.exe" }),
    { code: "NAPCAT_OFFLINE_GUARD_CONFIGURATION_INVALID" },
  );
});

test("invokeOfflineRecoveryGuard 在 Windows PowerShell 5.1 路径保留 Bypass 且剥离 PSExecutionPolicyPreference", async () => {
  const winPsPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const scriptPath = "C:\\ops\\invoke-napcat-offline-recovery.ps1";
  const inherited = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    PSExecutionPolicyPreference: "Bypass",
    psexecutionpolicypreference: "RemoteSigned",
    NAPCAT_TEST_KEEP: "preserved",
  };
  const before = { ...inherited };

  for (const powershellPath of [null, winPsPath]) {
    const calls = [];
    const result = await invokeOfflineRecoveryGuard({ action: "quick-login" }, {
      scriptPath,
      timeoutMs: 15_000,
      powershellPath,
      env: inherited,
      exec(executable, args, options, callback) {
        calls.push({ executable, args, options });
        return {
          stdin: {
            on() {},
            end() {
              callback(null, JSON.stringify({
                status: "deferred",
                changed: false,
                reason: "invalid_request",
                nativeQuickLoginVerified: false,
              }));
            },
          },
        };
      },
    });
    assert.deepEqual(result, {
      status: "deferred",
      changed: false,
      reason: "invalid_request",
      nativeQuickLoginVerified: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(path.win32.basename(calls[0].executable).toLowerCase(), "powershell.exe");
    assert.deepEqual(calls[0].args, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ]);
    const envKeysLower = Object.keys(calls[0].options.env).map((key) => key.toLowerCase());
    assert.equal(envKeysLower.includes("psexecutionpolicypreference"), false);
    assert.match(calls[0].options.env.PSModulePath, /WindowsPowerShell\\v1\.0\\Modules$/i);
    assert.equal(calls[0].options.env.NAPCAT_TEST_KEEP, "preserved");
  }
  assert.deepEqual(inherited, before);
});

test("invokePowerShellScript 与 invokePowerShellCommand 按 pwsh.exe 零 Bypass 与 powershell.exe 保留 Bypass 显式分流", async () => {
  const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const winPsPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const scriptPath = "C:\\ops\\login.ps1";
  const cleanEnv = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "C:\\Dirty\\Modules",
    PSExecutionPolicyPreference: "Bypass",
  };

  const scriptCalls = [];
  const captureScript = (executable, argumentsList, options, callback) => {
    scriptCalls.push({ executable, argumentsList, options });
    callback(null, "ok\n", "");
  };
  await invokePowerShellScript(scriptPath, ["-NoQr"], { env: cleanEnv, powershellPath: pwshPath, execFileImpl: captureScript });
  await invokePowerShellScript(scriptPath, ["-NoQr"], { env: cleanEnv, powershellPath: winPsPath, execFileImpl: captureScript });
  await invokePowerShellScript(scriptPath, ["-NoQr"], { env: cleanEnv, execFileImpl: captureScript });

  assert.equal(scriptCalls[0].executable, pwshPath);
  assert.equal(scriptCalls[0].argumentsList.some((arg) => /executionpolicy|bypass/i.test(arg)), false);
  assert.equal(Object.keys(scriptCalls[0].options.env).some((key) => key.toLowerCase() === "psmodulepath"), false);
  assert.equal(Object.keys(scriptCalls[0].options.env).some((key) => key.toLowerCase() === "psexecutionpolicypreference"), false);

  for (const call of [scriptCalls[1], scriptCalls[2]]) {
    assert.equal(path.win32.basename(call.executable).toLowerCase(), "powershell.exe");
    const policyIndex = call.argumentsList.indexOf("-ExecutionPolicy");
    assert.ok(policyIndex >= 0 && call.argumentsList[policyIndex + 1] === "Bypass");
    assert.equal(Object.keys(call.options.env).some((key) => key.toLowerCase() === "psexecutionpolicypreference"), false);
    assert.match(call.options.env.PSModulePath, /WindowsPowerShell\\v1\.0\\Modules$/i);
  }

  const commandCalls = [];
  const captureCommand = (executable, argumentsList, options, callback) => {
    commandCalls.push({ executable, argumentsList, options });
    callback(null, JSON.stringify({ ok: true }), "");
  };
  await invokePowerShellCommand("Write-Output '{}'", { env: cleanEnv, powershellPath: pwshPath, execFileImpl: captureCommand });
  await invokePowerShellCommand("Write-Output '{}'", { env: cleanEnv, powershellPath: winPsPath, execFileImpl: captureCommand });

  assert.equal(commandCalls[0].executable, pwshPath);
  assert.equal(commandCalls[0].argumentsList.some((arg) => /executionpolicy|bypass/i.test(arg)), false);
  assert.equal(Object.keys(commandCalls[0].options.env).some((key) => key.toLowerCase() === "psmodulepath"), false);
  assert.equal(Object.keys(commandCalls[0].options.env).some((key) => key.toLowerCase() === "psexecutionpolicypreference"), false);

  assert.equal(commandCalls[1].executable, winPsPath);
  const cmdPolicyIndex = commandCalls[1].argumentsList.indexOf("-ExecutionPolicy");
  assert.ok(cmdPolicyIndex >= 0 && commandCalls[1].argumentsList[cmdPolicyIndex + 1] === "Bypass");
  assert.equal(Object.keys(commandCalls[1].options.env).some((key) => key.toLowerCase() === "psexecutionpolicypreference"), false);
});

test("runSupervisorService 的 showOfflineNotice 按 pwsh.exe 零 Bypass 与 powershell.exe 保留 Bypass 双分流", async (context) => {
  const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const winPsPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const prevHostPs = process.env.NAPCAT_POWERSHELL_PATH;
  const prevHostGuardPs = process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH;
  process.env.NAPCAT_POWERSHELL_PATH = pwshPath;
  process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH = pwshPath;
  context.after(() => {
    if (prevHostPs === undefined) delete process.env.NAPCAT_POWERSHELL_PATH;
    else process.env.NAPCAT_POWERSHELL_PATH = prevHostPs;
    if (prevHostGuardPs === undefined) delete process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH;
    else process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH = prevHostGuardPs;
  });
  for (const [label, configuredPath, expectBypass] of [
    ["pwsh", pwshPath, false],
    ["winps-explicit", winPsPath, true],
    ["winps-default", null, true],
  ]) {
    const fixture = createFixture();
    context.after(fixture.cleanup);
    const barrier = path.join(path.dirname(fixture.runtimeStatePath), "napcat-offline-recovery.json");
    fs.mkdirSync(path.dirname(barrier), { recursive: true });
    const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, "utf8"));
    fs.writeFileSync(fixture.bindingPath, JSON.stringify({ ...binding, controlPlane: { localMachine: "development" } }));
    const noticeConfig = path.join(fixture.root, "interactive-config.json");
    fs.writeFileSync(noticeConfig, JSON.stringify({ offlineNoticeEnabled: true }));
    const privateEnv = JSON.parse(fs.readFileSync(fixture.privateEnvPath, "utf8"));
    fs.writeFileSync(fixture.privateEnvPath, JSON.stringify({
      ...privateEnv,
      NAPCAT_OFFLINE_INTERACTIVE_CONFIG: noticeConfig,
      ...(configuredPath ? { NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH: configuredPath } : {}),
    }));
    fs.writeFileSync(barrier, JSON.stringify({ ...loadOfflineRecoveryState(), needsManual: true }));
    const calls = [];
    await runSupervisorService(baseOptions(fixture, {
      useWindowsOfflineGuard: true,
      env: {
        SystemRoot: "C:\\Windows",
        PSModulePath: "C:\\Dirty\\Modules",
        PSExecutionPolicyPreference: "Bypass",
      },
      checkNapCatStatus: async () => ({ reachable: true, runtimeStatus: { online: false, good: true } }),
      offlineRecoveryGuard: async () => { throw new Error("unexpected guard"); },
      execFileImpl(executable, args, options, callback) {
        calls.push({ executable, args, options });
        callback(null, JSON.stringify({ status: "notice_returned" }), "");
      },
    }));
    assert.equal(calls.length, 1, `expected single notice launch for ${label}`);
    assert.equal(calls[0].args.includes("-File"), true);
    assert.equal(calls[0].args.some((arg) => /show-napcat-offline-notice\.ps1$/i.test(arg)), true);
    const envKeysLower = Object.keys(calls[0].options.env).map((key) => key.toLowerCase());
    assert.equal(envKeysLower.includes("psexecutionpolicypreference"), false);
    if (expectBypass) {
      assert.equal(path.win32.basename(calls[0].executable).toLowerCase(), "powershell.exe");
      const policyIndex = calls[0].args.indexOf("-ExecutionPolicy");
      assert.ok(policyIndex >= 0 && calls[0].args[policyIndex + 1] === "Bypass");
      assert.match(calls[0].options.env.PSModulePath, /WindowsPowerShell\\v1\.0\\Modules$/i);
    } else {
      assert.equal(calls[0].executable, pwshPath);
      assert.equal(calls[0].args.some((arg) => /executionpolicy|bypass/i.test(arg)), false);
      assert.equal(envKeysLower.includes("psmodulepath"), false);
    }
  }
});
