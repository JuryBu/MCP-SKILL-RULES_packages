import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_REACHABLE_OFFLINE_GRACE_MS,
  OFFLINE_RECOVERY_EMBARGO_MS,
  OFFLINE_RECOVERY_STABLE_MS,
  loadOfflineRecoveryState,
  nativeQuickLoginEvidence,
  observeOfflineRecovery,
  ownedQqRoot,
  ownedStaleLaunchRoot,
  reachableOfflineDecision,
  reserveOfflineRecoveryAttempt,
  retainVerifiedNativeLogin,
  snapshotNativeLoginInputs,
  writeOfflineRecoveryBarrier,
} from "../src/napcat-offline-recovery.mjs";

const initialTime = Date.parse("2026-01-01T00:00:00Z");
const offline = { known: true, reachable: true, online: false, ready: false };
const ready = { known: true, reachable: true, online: true, ready: true };
const observe = (state, napcat, root, now) => observeOfflineRecovery(state, { napcat, root, now, maxReadyGapMs: 120_000 });

test("an old launch tree can requalify after a definite connection refusal; multiple roots cannot", () => {
  const birth = new Date(initialTime - 1000).toISOString();
  const root = { Name: "node.exe", ProcessId: 123, CreationDate: birth, CommandLine: "fixture-only" };
  const child = { ...root, ProcessId: 124, ParentProcessId: 123 };
  assert.equal(ownedStaleLaunchRoot([root, child]).pid, 123);
  assert.equal(ownedQqRoot([root, child]), null);
  assert.equal(ownedStaleLaunchRoot([root, { ...child, ParentProcessId: 999 }]), null);
});
const main = { Name: "QQ.exe", ProcessId: 123, CreationDate: new Date(initialTime - 1000).toISOString(), CommandLine: '"C:\\Fixture\\QQ.exe" --boot' };
const worker = { ...main, CommandLine: '"C:\\Fixture\\QQ.exe" --type=renderer', ProcessId: 124 };
const mainRoot = ownedQqRoot([main, worker]);
const another = ownedQqRoot([{ ...main, ProcessId: 127 }]);

test("a transient Windows sharing failure keeps the previous barrier until a bounded replacement succeeds",
  { skip: process.platform !== "win32" }, context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-barrier-replacement-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const barrier = path.join(directory, "barrier.json");
    const prior = { ...loadOfflineRecoveryState(), needsManual: true };
    writeOfflineRecoveryBarrier(barrier, prior);
    const protectedBytes = fs.readFileSync(barrier);
    let replacements = 0;
    const target = { ...prior, noticeAttemptAt: initialTime };
    writeOfflineRecoveryBarrier(barrier, target, { ...fs, renameSync(source, destination) {
      assert.deepEqual(fs.readFileSync(barrier), protectedBytes);
      if (++replacements < 3) throw Object.assign(new Error("transient fixture"), { code: "EPERM" });
      fs.renameSync(source, destination);
    } });
    assert.equal(replacements, 3);
    const actual = loadOfflineRecoveryState(JSON.parse(fs.readFileSync(barrier, "utf8")));
    assert.equal(actual.noticeAttemptAt, initialTime);
    assert.equal(actual.noticeAt, null);
    assert.deepEqual(fs.readdirSync(directory), ["barrier.json"]);
  });

test("a denied durable flush leaves the prior barrier intact and publishes nothing", context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-flush-denied-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const barrier = path.join(directory, "barrier.json");
  const prior = Buffer.from(JSON.stringify(loadOfflineRecoveryState()));
  fs.writeFileSync(barrier, prior);
  let replacements = 0;
  const denied = Object.assign(new Error("fixture flush denied"), { code: "ERR_ACCESS_DENIED" });
  assert.throws(() => writeOfflineRecoveryBarrier(barrier, { ...loadOfflineRecoveryState(), needsManual: true }, {
    ...fs,
    fsyncSync() { throw denied; },
    renameSync() { replacements += 1; },
  }), { code: "ERR_ACCESS_DENIED" });
  assert.equal(replacements, 0);
  assert.deepEqual(fs.readFileSync(barrier), prior);
  assert.deepEqual(fs.readdirSync(directory), ["barrier.json"]);
});

test("the QQ root remains stable while Electron helpers restart; two genuine roots are unverified", () => {
  assert.ok(mainRoot);
  assert.deepEqual(ownedQqRoot([main, { ...worker, ProcessId: 125 }]), mainRoot);
  assert.equal(ownedQqRoot([main, { ...main, ProcessId: 129 }]), null);
  assert.equal(ownedQqRoot([{ ...main, CommandLine: "" }]), null);
});

test("the same reachable offline root has a full grace interval and a new root restarts the grace", () => {
  const start = observe(loadOfflineRecoveryState(), offline, mainRoot, initialTime);
  const threshold = initialTime + DEFAULT_REACHABLE_OFFLINE_GRACE_MS;
  assert.equal(reachableOfflineDecision(start, threshold - 1), "reachable_offline_preserved");
  assert.equal(reachableOfflineDecision(observe(start, offline, mainRoot, threshold), threshold), "eligible");
  assert.equal(reachableOfflineDecision(observe(start, offline, another, threshold), threshold), "reachable_offline_preserved");
  assert.equal(reachableOfflineDecision(observe(start, { ...offline, known: false }, mainRoot, threshold), threshold), "offline_root_unverified");
  assert.equal(reachableOfflineDecision(observe(start, { ...offline, online: true }, mainRoot, threshold), threshold), "offline_root_unverified");
});

test("a durable unresolved attempt survives process and supervisor restarts and never retries", () => {
  const ended = initialTime + DEFAULT_REACHABLE_OFFLINE_GRACE_MS;
  const sample = observe(loadOfflineRecoveryState(), offline, mainRoot, initialTime);
  const attempted = reserveOfflineRecoveryAttempt(sample, ended);
  assert.ok(Buffer.byteLength(JSON.stringify(attempted)) < 512);
  const recovered = loadOfflineRecoveryState(JSON.parse(JSON.stringify(attempted)));
  const current = observe(recovered, offline, another, ended + OFFLINE_RECOVERY_EMBARGO_MS * 2);
  assert.equal(current.needsManual, true);
  assert.equal(reachableOfflineDecision(current, current.offlineSince + DEFAULT_REACHABLE_OFFLINE_GRACE_MS), "manual_login_required");
  assert.throws(() => reserveOfflineRecoveryAttempt(current, current.offlineSince + DEFAULT_REACHABLE_OFFLINE_GRACE_MS),
    /NAPCAT_OFFLINE_ATTEMPT_NOT_ELIGIBLE/u);
});

test("a brief health sample and a gap cannot rearm; stable health and rolling embargo both apply", () => {
  const ended = initialTime + DEFAULT_REACHABLE_OFFLINE_GRACE_MS;
  let state = reserveOfflineRecoveryAttempt(observe(loadOfflineRecoveryState(), offline, mainRoot, initialTime), ended);
  state = observe(state, ready, mainRoot, ended + 1000);
  assert.equal(state.needsManual, false);
  state = observe(state, ready, mainRoot, ended + 10 * 60_000);
  assert.equal(state.rearmed, false);
  const stableAt = state.readySince;
  for (let sampleAt = stableAt + 60_000; sampleAt <= stableAt + OFFLINE_RECOVERY_STABLE_MS; sampleAt += 60_000) {
    state = observe(state, ready, mainRoot, sampleAt);
  }
  assert.equal(state.rearmed, true);
  const embargoEnds = ended + OFFLINE_RECOVERY_EMBARGO_MS;
  state = observe(loadOfflineRecoveryState(state), offline, another, embargoEnds - DEFAULT_REACHABLE_OFFLINE_GRACE_MS - 200);
  assert.equal(reachableOfflineDecision(state, embargoEnds - 1), "reachable_offline_recovery_embargo");
  assert.equal(reachableOfflineDecision(state, embargoEnds), "eligible");
  assert.equal(reachableOfflineDecision(loadOfflineRecoveryState({ schemaVersion: 2 }), embargoEnds), "recovery_state_unverified");
});

test("native login proof authorizes only its same layout and exact original inputs without opening a credential", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-offline-evidence-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "qq-profile");
  fs.mkdirSync(profile);
  const files = {
    deployment: path.join(root, "deployment.json"),
    startup: path.join(root, "startup-ps7.json"),
    binding: path.join(root, "binding.json"),
    login: path.join(root, "start-napcat-login.ps1"),
  };
  fs.writeFileSync(files.deployment, JSON.stringify({ qqProfileLayout: "shared_root" }));
  fs.writeFileSync(files.startup, "{}\n");
  fs.writeFileSync(files.binding, "{}\n");
  fs.writeFileSync(files.login, "fixture-only\n");
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const sigs = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, digest(fs.readFileSync(file))]));
  const resolvedProfile = fs.realpathSync(profile);
  sigs.profile = digest(Buffer.from(process.platform === "win32" ? resolvedProfile.toUpperCase() : resolvedProfile));
  const route = { accountStateDir: root, qqUserDataDir: profile, bindingPath: files.binding, loginScriptPath: files.login };
  const evidence = path.join(root, "native-quick-login-verified.json");
  const body = {
    schema: "napcat.native-quick-login-verified/v1", mode: "no-qr-no-password-fallback", result: "verified-online-from-own-launch",
    provedAt: initialTime, qqProfileLayout: "shared_root", sha256: sigs,
  };
  assert.equal(nativeQuickLoginEvidence(route, initialTime), false);
  fs.writeFileSync(evidence, JSON.stringify(body));
  fs.writeFileSync(path.join(root, "credential.json"), "synthetic never read");
  const fixtureFs = { ...fs, readFileSync(filename, ...args) {
    assert.notEqual(path.basename(filename), "credential.json");
    return fs.readFileSync(filename, ...args);
  } };
  const result = nativeQuickLoginEvidence(route, initialTime + 1000, fixtureFs);
  assert.deepEqual(result, { fileSha256: digest(fs.readFileSync(evidence)), sha256: sigs, provedAt: initialTime });
  assert.equal(nativeQuickLoginEvidence(route, initialTime + 8 * 24 * 60 * 60_000, fixtureFs), false);
  fs.writeFileSync(files.startup, '{"changed":true}\n');
  assert.equal(nativeQuickLoginEvidence(route, initialTime + 1000, fixtureFs), false);
});

test("registered legacy startup without a PS7 plan needs an explicit matching pin and freshly verified login", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-offline-legacy-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["account/state", "account/ops", "profile"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  const accountStateDir = path.join(root, "account/state");
  const launcher = path.join(root, "account/ops/start-local-napcat.ps1");
  const route = { accountStateDir, qqUserDataDir: path.join(root, "profile"),
    bindingPath: path.join(root, "binding.json"), loginScriptPath: path.join(root, "start-napcat-login.ps1") };
  for (const file of [path.join(accountStateDir, "deployment.json"), route.bindingPath, route.loginScriptPath]) fs.writeFileSync(file, "{}");
  fs.writeFileSync(launcher, "fixture registered startup\n");
  assert.equal(snapshotNativeLoginInputs(route), null);
  route.legacyStartupSha256 = "1".repeat(64);
  assert.equal(snapshotNativeLoginInputs(route), null);
  route.legacyStartupSha256 = createHash("sha256").update(fs.readFileSync(launcher)).digest("hex");
  const before = snapshotNativeLoginInputs(route);
  assert.equal(before.startupKind, "registered-legacy-launcher");
  assert.equal(nativeQuickLoginEvidence(route, initialTime), false);
  assert.equal(retainVerifiedNativeLogin({ paths: route, before, now: initialTime, confirmed: false }), false);
  assert.equal(retainVerifiedNativeLogin({ paths: route, before, now: initialTime, confirmed: true }), true);
  assert.ok(nativeQuickLoginEvidence(route, initialTime));
  fs.writeFileSync(path.join(accountStateDir, "startup-ps7.json"), "{}");
  assert.equal(nativeQuickLoginEvidence(route, initialTime), false);
});
