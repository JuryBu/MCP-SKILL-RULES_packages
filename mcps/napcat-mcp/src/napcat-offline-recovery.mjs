import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renameReplaceSync } from "./atomic-file.mjs";

export const DEFAULT_REACHABLE_OFFLINE_GRACE_MS = 30 * 60_000;
export const OFFLINE_RECOVERY_STABLE_MS = 15 * 60_000;
export const OFFLINE_RECOVERY_EMBARGO_MS = 12 * 60 * 60_000;

const time = value => Number.isSafeInteger(value) && value >= 0;
const optionalTime = value => value === null || time(value);
const validFingerprint = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const initialState = () => ({
  schemaVersion: 1,
  root: null,
  offlineSince: null,
  attemptAt: null,
  readySince: null,
  lastReadyAt: null,
  rearmed: false,
  needsManual: false,
  manualAfterVerifiedStopAt: null,
  noticeAt: null,
  noticeAttemptAt: null,
  noticeRetryAt: null,
});

export function loadOfflineRecoveryState(value) {
  if (value === undefined) return initialState();
  if (!value || value.schemaVersion !== 1
    || ![value.offlineSince, value.attemptAt, value.readySince, value.lastReadyAt, value.noticeAt,
      value.manualAfterVerifiedStopAt ?? null, value.noticeAttemptAt ?? null, value.noticeRetryAt ?? null].every(optionalTime)
    || !(value.root === null || validFingerprint(value.root))
    || typeof value.rearmed !== "boolean" || typeof value.needsManual !== "boolean"
    || (time(value.manualAfterVerifiedStopAt) && !value.needsManual)
    || (value.attemptAt === null && value.rearmed)
    || (!value.needsManual && value.noticeAt !== null && value.attemptAt === null)
    || (value.rearmed && value.needsManual)) return null;
  return { ...initialState(), attemptAt: value.attemptAt, rearmed: value.rearmed,
    needsManual: value.needsManual, manualAfterVerifiedStopAt: value.manualAfterVerifiedStopAt ?? null, noticeAt: value.noticeAt,
    noticeAttemptAt: value.noticeAttemptAt ?? null, noticeRetryAt: value.noticeRetryAt ?? null };
}

export function ownedQqRoot(processes) {
  const candidates = processes.filter(row => String(row.name ?? row.Name ?? "").toLowerCase() === "qq.exe")
    .filter(row => !/(?:^|\s)--type(?:[=\s]|$)/iu.test(row.commandLine ?? row.CommandLine ?? ""));
  if (candidates.length !== 1) return null;
  return nativeProcessIdentity(candidates[0]);
}

function nativeProcessIdentity(row) {
  const pid = Number(row.pid ?? row.processId ?? row.ProcessId);
  const creationDate = row.creationDate ?? row.CreationDate;
  const commandLine = row.commandLine ?? row.CommandLine;
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof creationDate !== "string" || !Number.isFinite(Date.parse(creationDate))
    || typeof commandLine !== "string" || !commandLine.trim()) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify([pid, Date.parse(creationDate)])).digest("hex");
  return { pid, creationDate, fingerprint };
}

export function ownedStaleLaunchRoot(processes) {
  const qqRoot = ownedQqRoot(processes);
  if (qqRoot) return qqRoot;
  if (processes.some(row => /^(qq|qqnt|qqex)(\.exe)?$/iu.test(row.name ?? row.Name ?? ""))) return null;
  const ids = new Set(processes.map(row => Number(row.pid ?? row.processId ?? row.ProcessId)));
  const roots = processes.filter(row => !ids.has(Number(row.parentPid ?? row.parentProcessId ?? row.ParentProcessId)));
  return roots.length === 1 ? nativeProcessIdentity(roots[0]) : null;
}

export function observeOfflineRecovery(state, { napcat, root, now, maxReadyGapMs }) {
  if (!state || !time(now)) return state;
  if (state.attemptAt !== null && state.attemptAt > now) return { ...state, root: null, offlineSince: null };
  const next = { ...state };
  if (napcat?.ready === true && napcat.online === true) {
    next.root = null;
    next.offlineSince = null;
    next.needsManual = false;
    next.manualAfterVerifiedStopAt = null;
    next.noticeAt = null;
    next.noticeAttemptAt = null;
    next.noticeRetryAt = null;
    if (next.attemptAt !== null) {
      const continuous = time(next.readySince) && time(next.lastReadyAt) && next.lastReadyAt <= now
        && Number.isSafeInteger(maxReadyGapMs) && maxReadyGapMs > 0 && now - next.lastReadyAt <= maxReadyGapMs;
      next.readySince = continuous ? next.readySince : now;
      next.lastReadyAt = now;
      if (now - next.readySince >= OFFLINE_RECOVERY_STABLE_MS) next.rearmed = true;
    }
    return next;
  }
  next.readySince = null;
  next.lastReadyAt = null;
  if (napcat?.known === true && napcat.reachable === true && napcat.online === false && validFingerprint(root?.fingerprint)) {
    if (next.root !== root.fingerprint || !time(next.offlineSince) || next.offlineSince > now) {
      next.root = root.fingerprint;
      next.offlineSince = now;
    }
  } else {
    next.root = null;
    next.offlineSince = null;
  }
  return next;
}

export function reachableOfflineDecision(state, now, graceMs = DEFAULT_REACHABLE_OFFLINE_GRACE_MS) {
  if (!state || !time(now) || !Number.isSafeInteger(graceMs) || graceMs <= 0) return "recovery_state_unverified";
  if (!time(state.offlineSince) || !validFingerprint(state.root) || state.offlineSince > now) return "offline_root_unverified";
  if (state.needsManual) return "manual_login_required";
  if (now - state.offlineSince < graceMs) return "reachable_offline_preserved";
  if (state.attemptAt !== null && (!state.rearmed || now - state.attemptAt < OFFLINE_RECOVERY_EMBARGO_MS)) {
    return "reachable_offline_recovery_embargo";
  }
  return "eligible";
}

export function reserveOfflineRecoveryAttempt(state, now, graceMs) {
  if (reachableOfflineDecision(state, now, graceMs) !== "eligible") throw new Error("NAPCAT_OFFLINE_ATTEMPT_NOT_ELIGIBLE");
  return { ...state, attemptAt: now, readySince: null, lastReadyAt: null, rearmed: false, needsManual: true, manualAfterVerifiedStopAt: null,
    noticeAt: null, noticeAttemptAt: null, noticeRetryAt: null };
}

function regularBytes(file, limit, fileSystem) {
  const before = fileSystem.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > limit) {
    throw new Error("NAPCAT_RECOVERY_FILE_UNVERIFIED");
  }
  const bytes = fileSystem.readFileSync(file);
  const after = fileSystem.lstatSync(file);
  if (bytes.length !== before.size || after.size !== before.size || after.ino !== before.ino
    || after.mtimeMs !== before.mtimeMs || !after.isFile() || after.isSymbolicLink()) {
    throw new Error("NAPCAT_RECOVERY_FILE_CHANGED");
  }
  return bytes;
}

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

export function readOfflineRecoveryBarrier(file, fileSystem = fs) {
  try {
    return loadOfflineRecoveryState(json(regularBytes(file, 512, fileSystem)));
  } catch (error) {
    return error.code === "ENOENT" ? initialState() : null;
  }
}

export function confirmOriginalSupervisorHold({
  barrierPath, barrierSha256, runtimePath, runtimeSha256,
}, fileSystem = fs) {
  if (![barrierSha256, runtimeSha256].every(validFingerprint)
    || ![barrierPath, runtimePath].every(value => typeof value === "string" && path.isAbsolute(value))) return false;
  try {
    const barrier = regularBytes(barrierPath, 512, fileSystem);
    const runtime = regularBytes(runtimePath, 256 * 1024, fileSystem);
    if (digest(barrier) !== barrierSha256 || digest(runtime) !== runtimeSha256) return false;
    const holds = loadOfflineRecoveryState(json(barrier));
    const legacy = json(runtime).login;
    return holds?.needsManual === true && legacy?.blocked === true
      && legacy.blockedReason?.code === "NAPCAT_MANUAL_LOGIN_REQUIRED";
  } catch { return false; }
}

function writeExactJson(file, body, limit, fileSystem) {
  const data = Buffer.from(JSON.stringify(body) + "\n");
  if (data.length > limit) throw new Error("NAPCAT_RECOVERY_RECORD_TOO_LARGE");
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
  const handle = fileSystem.openSync(temp, "wx", 0o600);
  try {
    try {
      fileSystem.writeFileSync(handle, data);
      fileSystem.fsyncSync(handle);
    } finally {
      fileSystem.closeSync(handle);
    }
    renameReplaceSync(temp, file, { renameSync: fileSystem.renameSync.bind(fileSystem) });
    if (!regularBytes(file, limit, fileSystem).equals(data)) throw new Error("NAPCAT_RECOVERY_RECORD_READBACK_FAILED");
  } finally {
    try { fileSystem.unlinkSync(temp); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function writeOfflineRecoveryBarrier(file, value, fileSystem = fs) {
  const durable = { ...initialState(), attemptAt: value.attemptAt, needsManual: value.needsManual,
    manualAfterVerifiedStopAt: value.manualAfterVerifiedStopAt ?? null,
    rearmed: value.rearmed, noticeAt: value.noticeAt,
    noticeAttemptAt: value.noticeAttemptAt ?? null, noticeRetryAt: value.noticeRetryAt ?? null };
  if (!loadOfflineRecoveryState(durable)) throw new Error("NAPCAT_OFFLINE_BARRIER_INVALID");
  writeExactJson(file, durable, 512, fileSystem);
  return value;
}

export function durableRecoveryChanged(before, after) {
  return Boolean(before && after && ["attemptAt", "needsManual", "manualAfterVerifiedStopAt", "rearmed", "noticeAt", "noticeAttemptAt", "noticeRetryAt"]
    .some(key => before[key] !== after[key]));
}

function readStartupIdentity(paths, accountDir, fileSystem) {
  const plan = path.join(accountDir, "startup-ps7.json");
  try {
    return { kind: "ps7-plan", sha256: digest(regularBytes(plan, 512 * 1024, fileSystem)) };
  } catch (error) {
    if (error.code !== "ENOENT" || !validFingerprint(paths.legacyStartupSha256)) throw error;
    const launcher = path.resolve(accountDir, "..", "ops", "start-local-napcat.ps1");
    const sha256 = digest(regularBytes(launcher, 512 * 1024, fileSystem));
    if (sha256 !== paths.legacyStartupSha256) throw new Error("NAPCAT_RECOVERY_STARTUP_NOT_REGISTERED");
    return { kind: "registered-legacy-launcher", sha256 };
  }
}

export function snapshotNativeLoginInputs(paths, fileSystem = fs) {
  if (!["accountStateDir", "qqUserDataDir", "bindingPath", "loginScriptPath"].every(key => path.isAbsolute(paths[key] ?? ""))) return null;
  try {
    const accountDir = fileSystem.realpathSync(paths.accountStateDir);
    const profileDir = fileSystem.realpathSync(paths.qqUserDataDir);
    if (!fileSystem.statSync(accountDir).isDirectory() || !fileSystem.statSync(profileDir).isDirectory()) return null;
    const deployment = regularBytes(path.join(accountDir, "deployment.json"), 512 * 1024, fileSystem);
    const qqProfileLayout = json(deployment).qqProfileLayout ?? "legacy_numeric";
    if (!["legacy_numeric", "shared_root"].includes(qqProfileLayout)) return null;
    const startup = readStartupIdentity(paths, accountDir, fileSystem);
    const sha256 = {
      deployment: digest(deployment),
      startup: startup.sha256,
      binding: digest(regularBytes(paths.bindingPath, 64 * 1024, fileSystem)),
      login: digest(regularBytes(paths.loginScriptPath, 512 * 1024, fileSystem)),
      profile: digest(Buffer.from(process.platform === "win32" ? profileDir.toUpperCase() : profileDir)),
    };
    return { accountDir, qqProfileLayout, startupKind: startup.kind, sha256 };
  } catch {
    return null;
  }
}

export function nativeQuickLoginEvidence(paths, now, fileSystem = fs) {
  if (!time(now)) return false;
  const current = snapshotNativeLoginInputs(paths, fileSystem);
  if (!current) return false;
  try {
    const proofBytes = regularBytes(path.join(current.accountDir, "native-quick-login-verified.json"), 4096, fileSystem);
    const proof = json(proofBytes);
    if (proof.schema !== "napcat.native-quick-login-verified/v1" || proof.mode !== "no-qr-no-password-fallback"
      || proof.result !== "verified-online-from-own-launch" || !time(proof.provedAt) || proof.provedAt > now
      || now - proof.provedAt > 7 * 24 * 60 * 60_000 || proof.qqProfileLayout !== current.qqProfileLayout
      || (proof.startupKind ?? "ps7-plan") !== current.startupKind) return false;
    return Object.entries(current.sha256).every(([field, hash]) => proof.sha256?.[field] === hash)
      ? { fileSha256: digest(proofBytes), sha256: current.sha256, provedAt: proof.provedAt }
      : false;
  } catch {
    return false;
  }
}

export function retainVerifiedNativeLogin({ paths, before, now, confirmed }, fileSystem = fs) {
  if (confirmed !== true || !before || !time(now)) return false;
  const current = snapshotNativeLoginInputs(paths, fileSystem);
  if (!current || current.accountDir !== before.accountDir || current.qqProfileLayout !== before.qqProfileLayout
    || current.startupKind !== before.startupKind
    || !Object.entries(current.sha256).every(([field, hash]) => before.sha256?.[field] === hash)) return false;
  writeExactJson(path.join(current.accountDir, "native-quick-login-verified.json"), {
    schema: "napcat.native-quick-login-verified/v1", mode: "no-qr-no-password-fallback",
    result: "verified-online-from-own-launch", provedAt: now, qqProfileLayout: current.qqProfileLayout,
    startupKind: current.startupKind, sha256: current.sha256,
  }, 4096, fileSystem);
  return true;
}
